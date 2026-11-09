/**
 * M6：`evidence.zip` 的生成器 —— **不依赖任何第三方 zip 库**。
 *
 * 为什么自己写：本机无外网（docs/README 记着），jszip/adm-zip 装不上。
 * 但更有力的理由是**我们只需要"写"，不需要"读"**：
 * 一个只写 store（level 0，不压缩）的 zip 是 ~150 行的字节拼装，
 * 而引一个库进来要背上它的传递依赖、以及"打包格式由第三方决定"这件事。
 *
 * **为什么故意不压缩**：证据包里的绝大部分内容（trace.jsonl、响应体、hierarchy XML）
 * 压了也就小 30–60%，而代价有两个：
 *  1. **deflate 让包内容不再可逐字节比对**。M7 的确定性验证要 diff 两次运行的产物，
 *     未压缩时 `diff <(unzip -p a.zip trace.jsonl) <(unzip -p b.zip trace.jsonl)`
 *     与"两次运行是否一致"完全等价；压缩后还得先保证压缩器输出稳定（这本身不成立）。
 *  2. 压缩是 CPU 活。跑几百个场景的 CI 里，这部分开销全部记在测试时长上，
 *     而它对定位问题一点帮助没有。
 * 真要省空间，压的是**整个包**（.zip.zip / tar.gz 交给上传环节），不是包内成员。
 *
 * 兼容性判据不是"我读得回来"（自己写自己读，错了也能对上一样的错），
 * 而是**外部工具认**：test/evidence.test.ts 里用系统的 `unzip -t` 与 `unzip -o`
 * 验包并逐字节比对成员内容。那才是"可独立打开"这条判据的意思。
 */
import { crc32 } from 'node:zlib';

/** zip 里的一个成员。名字用 `/` 分隔（zip 规范就是 `/`，不是平台分隔符） */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** DOS 时间戳来源（毫秒）。默认取 evidence 的 startedAt ——
   *  让同一批内容产出**字节完全相同**的包，这样 evidence 本身可以被哈希寻址、
   *  两个 run 产出相同证据时不用存两份。 */
  mtimeMs?: number;
}

/** zip64 的门槛。越过它不是"性能差一点"，而是**产出一个打不开的包**，
 *  所以宁可在这里拒绝并说清该怎么办（把大成员拆出去）。 */
const MAX_TOTAL = 0xffe00000; // 留足余量，别贴着 4GiB 边界

/**
 * 打包。返回 zip 的完整字节。
 * @throws 成员名带 `..` 或以 `/` 开头（防"解出到别处去"），或总量超 4GiB
 */
export function buildZip(entries: ZipEntry[], defaultMtimeMs = Date.now()): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) validateName(e.name);
  const total = entries.reduce((n, e) => n + e.data.byteLength, 0);
  if (total > MAX_TOTAL) {
    throw new RangeError(`证据总量 ${total} 字节超过 zip（非 zip64）上限。请把大成员（录屏/大响应体）单独存到对象存储，包里只留引用`);
  }

  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const { time, date } = dosStamp(e.mtimeMs ?? defaultMtimeMs);
    const crc = crc32(e.data) >>> 0;
    const size = e.data.byteLength;

    // 本地文件头（30 字节 + 名字）。签名 0x04034b50 = "PK\x03\x04"
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);            // version needed
    local.setUint16(6, 0x0800, true);        // flags: bit11 = 文件名是 UTF-8。**必须置**：
                                             // 不置时 macOS 原生解压器只能猜编码（猜错就是乱码），
                                             // Windows 资源管理器按 CP437 显示。
                                             // 注意：置了它，macOS 自带的 unzip 6.0 **仍然**解不出
                                             // 非 ASCII 成员名（它把名字喂给 mkdir 前按 locale
                                             // 转码，报 Illegal byte sequence 并拒绝整个包）。
                                             // 所以成员名刻意全 ASCII —— 见 evidence.test.ts
    local.setUint16(8, 0, true);             // method 0 = store（见文件头"为什么不压缩"）
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);         // 压缩后 = 原始（store）
    local.setUint32(22, size, true);
    local.setUint16(26, name.byteLength, true);
    local.setUint16(28, 0, true);            // extra 长度

    const localBytes = concat(local.buffer, name);
    parts.push(localBytes, e.data);

    // 中央目录项（46 字节 + 名字）。签名 0x02014b50
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);                // version made by
    c.setUint16(6, 20, true);                // version needed
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.byteLength, true);
    c.setUint16(30, 0, true);                // extra
    c.setUint16(32, 0, true);                // comment
    c.setUint16(34, 0, true);                // disk number
    c.setUint16(36, 0, true);                // internal attrs
    c.setUint32(38, 0o644 << 16, true);      // external attrs：POSIX 权限在高 16 位。
                                             // 不填的话 unzip 解出来权限随机，脚本类证据不可执行
    c.setUint32(42, offset, true);           // 本地头的位置 —— 打不开包的头号原因就是它错
    central.push(concat(c.buffer, name));

    offset += localBytes.byteLength + e.data.byteLength;
  }

  const cdStart = offset;
  const cd = concatAll(central);
  parts.push(cd);

  // EOCD（22 字节）。签名 0x06054b50。绝大多数工具从**文件尾**倒着找它
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cd.byteLength, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  parts.push(new Uint8Array(eocd.buffer));

  return concatAll(parts);
}

/**
 * 成员名校验。
 *
 * `../` 或以 `/` 开头的名字会让 `unzip -o` **写到包外去**（zip slip）。
 * 我们的成员名里有一路来自 `stepId`，而 stepId 是人/模型写的 ——
 * 一个名叫 `../../etc/x` 的步骤就能让"下载证据包"变成"任意文件写入"。
 * 这条必须在写侧拦，不能指望解侧老实。
 */
function validateName(name: string): void {
  if (!name) throw new RangeError('zip 成员名不能为空');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new RangeError(`zip 成员名必须是相对路径：${name}`);
  if (name.split('/').some((seg) => seg === '..' )) throw new RangeError(`zip 成员名不允许包含 ..（zip slip）：${name}`);
  if (name.includes('\\')) throw new RangeError(`zip 成员名必须用 / 分隔，不用反斜杠：${name}`);
}

/**
 * DOS 时间戳。zip 的时间格式是 1980 起的，比 Unix 少两位精度（秒只到 2 秒）。
 *
 * 1980 之前的时间**无法表示**：早先直接用 year-1980 会得到负数，
 * `& 0x7f` 截断后变成一个随机的未来年份，某些工具因此拒开整个包。
 * 这里钳到 1980 并让它可预期（而不是产出畸形包）。
 */
export function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  let year = d.getFullYear();
  if (year < 1980) {
    const fixed = new Date(Date.UTC(1980, 0, 1));
    year = fixed.getUTCFullYear();
    return { time: 0, date: ((year - 1980) << 9) | (1 << 5) | 1 };
  }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function concat(head: ArrayBuffer, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(new Uint8Array(head), 0);
  out.set(tail, head.byteLength);
  return out;
}

function concatAll(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((n, x) => n + x.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const x of list) { out.set(x, off); off += x.byteLength; }
  return out;
}

// ── 读取侧 ────────────────────────────────────────────────────────────────

/**
 * 读回一个 store-only zip 的成员。
 *
 * **只支持我们自己写出的那种**（store、非 zip64），这是有意的取舍：
 * 读侧存在的目的有且只有一个 —— 让**测试**能逐字节断言"包里的内容确实是那个字符串"，
 * 而真正的兼容性判据是外部 `unzip` 能不能打开（evidence.test.ts 里跑的就是它）。
 * 把它当通用 zip 解析器写，会诱导别人拿它去解用户上传的包，
 * 而它没有防 zip bomb、没有防 zip slip、不支持 deflate —— 那时它就是个漏洞。
 * 所以这里对不认识的包**直接抛**，而不是尽力解出来。
 */
export function readZipEntries(buf: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const out: Array<{ name: string; data: Uint8Array }> = [];
  let p = 0;
  while (p + 4 <= buf.byteLength && view.getUint32(p, true) === 0x04034b50) {
    const method = view.getUint16(p + 8, true);
    if (method !== 0) throw new RangeError(`readZipEntries 只支持 store(0)，遇到 method=${method}。它不是通用 zip 解析器，请勿用于解外部包`);
    const crc = view.getUint32(p + 14, true);
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const nameStart = p + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + size > buf.byteLength) throw new RangeError('zip 被截断：本地头声明的数据超出缓冲区');
    const name = dec.decode(buf.subarray(nameStart, nameStart + nameLen));
    const data = buf.slice(dataStart, dataStart + size);
    if ((crc32(data) >>> 0) !== crc) throw new RangeError(`zip 成员 ${name} 的 CRC 不匹配：包已损坏`);
    out.push({ name, data });
    p = dataStart + size;
  }
  return out;
}
