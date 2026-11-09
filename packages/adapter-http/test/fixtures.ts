/**
 * 测试用的 OpenAPI fixture —— **刻意写脏**，照 docs/05 §1 那张表逐条埋：
 * 缺 operationId、缺 path 参数定义、security 三层继承、`security: []` 显式公开、
 * 循环 schema、外部 $ref、deprecated、非 JSON 请求体、手写 example。
 *
 * 为什么不直接用一份干净的示例 spec：干净的 spec 只能证明"代码能跑"，
 * 而 M2 的全部风险都在脏数据上（真实 spec 里缺 operationId 的频率是"极高"）。
 */

export const dirtySpec = {
  openapi: '3.0.3',
  info: { title: 'shop', version: '1' },
  servers: [{ url: 'https://spec-says-this-is-wrong.example.com/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
    },
    schemas: {
      Order: {
        type: 'object',
        required: ['id', 'amount'],
        properties: {
          id: { type: 'string' },
          amount: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string', enum: ['new', 'paid'] },
          // 循环：Order.items[].parent 指回 Order
          items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
        },
      },
      Item: {
        type: 'object',
        properties: { sku: { type: 'string' }, parent: { $ref: '#/components/schemas/Order' } },
      },
      Error: { type: 'object', required: ['code'], properties: { code: { type: 'integer' } } },
    },
    parameters: {
      Page: { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1 } },
    },
  },
  paths: {
    // ① 缺 operationId（频率"极高"）+ 缺 path 参数定义（偷懒不写）
    '/orders/{id}': {
      get: {
        tags: ['订单'],
        summary: '查订单',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          // 注意：没有 {id} 的 parameter 定义，真实 spec 里非常常见
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' }, example: { id: 'A1', amount: 5 } } },
          },
          '404': { description: 'not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: { operationId: 'removeOrder', deprecated: true, responses: { '204': { description: 'no content' } } },
    },
    // ② path 级 parameters 被 operation 级覆盖
    '/users': {
      parameters: [
        { name: 'q', in: 'query', schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer' } },
      ],
      get: {
        operationId: 'listUsers',
        parameters: [
          // 同名同 in 覆盖 path 级：type 从 string 变 array，且带 style
          { name: 'q', in: 'query', style: 'pipeDelimited', explode: false, schema: { type: 'array', items: { type: 'string' } } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    // ③ `security: []` = **显式公开**，不得继承 spec 级的 bearerAuth
    '/public/health': {
      get: { operationId: 'health', security: [], responses: { '200': { description: 'ok' } } },
    },
    // ④ operation 级 security 覆盖 spec 级
    '/auth/token': {
      post: { operationId: 'login', security: [{ apiKeyQuery: [] }], responses: { '200': { description: 'ok' } } },
    },
    // ⑤ 带请求体 + 必填字段 + 多 example
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Order' },
              examples: { simple: { value: { id: 'B2', amount: 7 } }, rich: { value: { id: 'B3', amount: 9 } } },
            },
          },
        },
        responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
    },
    // ⑥ 非 JSON 请求体：要记 warn 而不是静默跳过
    '/avatar': {
      put: { operationId: 'uploadAvatar', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok' } } },
    },
    // ⑦ 坏掉的一条：$ref 指不到 —— 只该跳过这一条，其余照常
    '/broken': {
      get: { operationId: 'broken', parameters: [{ name: 'x', in: 'query', schema: { $ref: '#/components/schemas/Nope' } }], responses: { '200': { description: 'ok' } } },
    },
    // ⑧ 空 operation（手写残留），不该被收成一条 operation
    '/empty': { get: {} },
  },
} as const;

/** 外部文档，供跨文件 $ref 用 */
export const commonYaml = { Pagination: { type: 'object', properties: { page: { type: 'integer' } } } };
