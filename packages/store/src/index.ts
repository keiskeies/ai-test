/**
 * @atest/store —— 证据存储与报告出口（M6）。
 *
 * 这一层是**被允许碰磁盘的层之一**（另一个是 adapter-http 碰网络）。
 * 引擎侧只留端口（`ArtifactStore`），实现在这里 ——
 * 这样"引擎能在浏览器里跑"那条约束不会被证据功能一点点啃掉。
 *
 * 与 docs/01 §6 的对应：本包目前只做了「本地磁盘内容寻址」这一半，
 * drizzle schema 与 MySQL 索引是 P1 的事（服务端化时一起做）。
 * **不要**因为包名叫 store 就以为数据库那层已经有了。
 */
export * from './artifacts.js';
export * from './evidence.js';
export * from './ir-hash.js';
export * from './zip.js';
