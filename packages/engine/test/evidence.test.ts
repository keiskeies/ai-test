/**
 * 引擎**自动**产的证据（响应体落盘）。
 *
 * 立这个文件的原因是一次实测：接了真 DiskArtifactStore 跑一条**普通 http 步骤**
 * 拿到 200，结果是
 *     artifactIds = []        按 stepId 查到 0 条        ARTIFACT_STORE_MISSING 事件 0 条
 * 也就是**三句都不报警**的"证据压根没存"。而 `autoEvidence(...)` 那句一直存在，
 * 只是**只写在 openapiCall 那一条路上** —— 走 spec 的用户一切正常，
 * 手写 http 步骤的用户（最常见的第一条用例）拿到的 evidence.zip
 * 能正常打开、只有四份元数据、没有响应体，而排查失败第一个要看的正是响应体。
 *
 * 所以这里钉的是**两条请求路径都要存**，而不是"有一个地方存了"。
 * 只测一条路就等于没测：本仓这一类的第三例
 * （另两例：confidenceGate 只在解释器侧读、mutate 的锚点只覆盖一条路径）。
 *
 * 用内存 store 而不是 @atest/store：engine 不许依赖上层包
 * （tooling/lint-layers.mjs 强制），而这里要验的是"引擎有没有去存"，不是"磁盘上什么样"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { ArtifactStore } from '../src/adapters.js';
import { b, run, scen, type StepDraft } from './helpers.js';

/** 按 stepId 记账的内存 store。savedFor 就是"这个步骤的证据条数" */
function memStore(): { store: ArtifactStore; savedFor: (stepId: string) => number; kinds: () => string[] } {
  const rows: Array<{ stepId: string; kind: string }> = [];
  return {
    store: {
      async save(kind, _data, stepId) { rows.push({ stepId, kind }); return `art-${rows.length}`; },
      async load() { return undefined; },
    },
    savedFor: (stepId) => rows.filter((r) => r.stepId === stepId).length,
    kinds: () => rows.map((r) => r.kind),
  };
}

/** 两条路共用同一个响应：200 + 一个可辨认的响应体 */
const OK = { status: 200, headers: {}, body: { ok: true }, bodyText: '{"ok":true}', bytes: 11, truncated: false, durationMs: 3 };

const httpExec = () => ({ async send() { return { ...OK }; } });
const openapiExec = () => ({
  async send() { return { ...OK }; },
  async resolveOperation() { return { operationId: 'getThing', method: 'GET', urlTemplate: '/things/{id}', requiredBodyFields: [], deprecated: false }; },
});

describe('响应体落证据：两条请求路径都要存', () => {
  test('普通 http 步骤（手写 url，最常见的第一条用例）', async () => {
    const m = memStore();
    const r = await run(scen([{ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' } } as StepDraft]), {
      adapters: { http: httpExec() as never, artifactStore: m.store },
    });
    assert.equal(r.results[0]!.status, 'pass');
    assert.equal(m.savedFor('h'), 1, 'http 步骤没存证据：evidence.zip 里将没有响应体，而它看起来是完好的');
    assert.deepEqual(r.results[0]!.artifactIds, ['art-1'], '存了就要把 id 记在步骤结果上，否则报告指不到那份证据');
    assert.deepEqual(m.kinds(), ['http-response']);
  });

  test('openapiCall（走 spec 的那条路）', async () => {
    const m = memStore();
    // env.baseUrl 是必需的：openapiCall 的地址来自 spec 的 urlTemplate（相对路径），
    // IR 不写死域名是刻意的（docs/05 §1），所以域名由环境给。
    const r = await run(scen([{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '1' } } as StepDraft]), {
      adapters: { http: openapiExec() as never, artifactStore: m.store }, env: { baseUrl: 'https://t' },
    });
    assert.equal(r.results[0]!.status, 'pass', r.summary);
    assert.equal(m.savedFor('o'), 1);
    assert.deepEqual(m.kinds(), ['http-response'], '两条路要用同一个 kind，否则按 kind 做保留/清理的策略会漏掉一半');
  });

  test('没配存储时**吼一声**而不是静默，且步骤不因此变红', async () => {
    const r = await run(scen([{ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' } } as StepDraft]), {
      adapters: { http: httpExec() as never },
    });
    assert.equal(r.results[0]!.status, 'pass', '没接证据盘是部署配置问题，不该让每个 HTTP 步骤变红');
    assert.deepEqual(r.results[0]!.artifactIds, [], '没存就不许记 id（记了等于让证据包看起来完整而取不到东西）');
    assert.equal(r.events.filter((e) => JSON.stringify(e.data ?? {}).includes('ARTIFACT_STORE_MISSING')).length, 1,
      '必须至少吼一次：否则"没有证据"与"证据被清理了"在报告里长得一样');
  });

  test('一次运行只警告一次，不刷屏', async () => {
    const r = await run(scen([0, 1, 2, 3].map((i) => ({ ...b(`h${i}`), kind: 'http', request: { method: 'GET', url: `http://x/${i}` } } as StepDraft))), {
      adapters: { http: httpExec() as never },
    });
    assert.equal(r.events.filter((e) => JSON.stringify(e.data ?? {}).includes('ARTIFACT_STORE_MISSING')).length, 1,
      '200 步的套件会刷 200 条同样的事件，把人淹掉');
  });
});
