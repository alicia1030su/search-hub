# 真实联调证据（live_tested）

本目录只存放**真实厂商调用**的可复查记录。`provider-matrix.md` 与 catalog 里
标注 `live_tested` 的每一条，都必须能在这里找到对应文件。

## 当前记录

| Provider | 证据文件 | 说明 |
|---|---|---|
| `hackernews` | `hackernews.json` | Algolia 托管 API，公开可访问 |
| `crossref` | `crossref.json` | 公开 REST API |
| `openalex` | `openalex.json` | 公开 REST API |
| `pubmed` | `pubmed.json` | NCBI E-utilities |

## 什么算证据

一条记录必须包含：调用时间、请求 URL（不含凭证）、HTTP 状态、返回条数、
以及至少一条真实结果的 URL。**本地模拟服务、mock adapter、契约测试都不算。**

## 什么不算

- `mock_verified`：只证明代码路径正确，从不发网络请求。
- `documented`：按官方文档实现，没有跑过真实调用。
- 「能连上」但返回 0 条结果：那是失败，不是联调通过。

## 为什么必须存在这个目录

文档里写「已联调」是很容易的，验证起来却很难。把证据钉在仓库里，
才能让 `scripts/check-doc-consistency.mjs` 在有人声称 `live_tested` 却没有
记录时直接失败。
