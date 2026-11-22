// CSV/TSV 粘贴解析（§11.4.5）：首行=列头，制表符或逗号分隔，前端解析后只把结构交给后端。
// 后端 data_set 只认 columns + 等宽 rows（行宽不等 422 details.row），所以长度归一必须在这里做完，
// 并把「补了哪些行、砍了哪些行」如实告诉用户——静默改数据比报错更糟。

export interface PasteResult {
  columns: string[];
  rows: string[][];
  delimiter: string;
  padded: number[];      // 比列头短、已补空串的行号（1 起，指数据行）
  overflow: number[];    // 比列头长、已截断的行号（1 起）
  duplicates: string[];  // 重复列名（后端 _validate_table 按「列名不能重复」422，这样的表存不回去）
  droppedBlank: number;  // 丢掉的整行空白行数
  capped: boolean;       // 超过 MAX_ROWS：第 2001 行起被丢弃，调用方必须播报，不许静默截断
}

const MAX_ROWS = 2000; // 防止误粘一整张表把浏览器表格编辑器卡死；砍掉的行必须进 PasteResult.capped 如实上报

export function parseTabular(text: string): PasteResult {
  const lines = (text ?? "").split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== "");
  const droppedBlank = lines.length - kept.length;
  const empty: PasteResult = {
    columns: [], rows: [], delimiter: "", padded: [], overflow: [], duplicates: [], droppedBlank, capped: false,
  };
  if (kept.length === 0) return empty;
  // 制表符优先：从 Excel/Numbers 复制出来必然是 TSV；逗号只在没有制表符时兜底
  const delimiter = kept[0].includes("\t") ? "\t" : ",";
  const cells = (l: string): string[] => l.split(delimiter).map((c) => c.trim());
  const columns = cells(kept[0]).map((c, i) => (c === "" ? "列" + (i + 1) : c));
  const padded: number[] = [];
  const overflow: number[] = [];
  let rows = kept.slice(1).map((l, i) => {
    const cs = cells(l);
    if (cs.length < columns.length) { padded.push(i + 1); return cs.concat(Array(columns.length - cs.length).fill("")); }
    if (cs.length > columns.length) { overflow.push(i + 1); return cs.slice(0, columns.length); }
    return cs;
  });
  const capped = rows.length > MAX_ROWS;
  rows = rows.slice(0, MAX_ROWS);
  if (capped) { // 超量截断后行号提示要跟着收口，否则提示里出现不存在的行
    while (padded.length && padded[padded.length - 1] > MAX_ROWS) padded.pop();
    while (overflow.length && overflow[overflow.length - 1] > MAX_ROWS) overflow.pop();
  }
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const c of columns) { if (seen.has(c) && !duplicates.includes(c)) duplicates.push(c); seen.add(c); }
  return { columns, rows, delimiter, padded, overflow, duplicates, droppedBlank, capped };
}

/** 表格编辑器 → 粘贴框回填用（保持可再编辑，不是只读预览）。 */
export function toTabular(columns: string[], rows: string[][]): string {
  return [columns.join("\t")].concat(rows.map((r) => r.join("\t"))).join("\n");
}
