# 转关纸档的扫描与调阅来源

本地合成记录模拟口岸纸档的扫描站、卷登记端、调阅台及补扫班组。

## 本地运行

使用 Node.js 22.23.4。项目只使用 Node.js 自带的运行库。运行 `npm test` 检查来源接口，运行 `npm start` 启动服务。默认监听 `127.0.0.1:4100`，可通过 `PORT` 调整。根路径列出来源名及当前回放阶段。

## 接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/scanner` | 作业以站点与批次共同标识。`feed.mode` 的 `duplex` 表示连续双面，`reverse` 表示按翻好的整摞补扫背面，`front` 或 `single` 表示单面进纸。`frontJob` 指同站正面批次。`discharged` 列出确认稳定出纸的位置，`jamAfter` 是现场报告的卡纸边界。 |
| `/source/clerk` | `physical` 表示实体纸件。共用纸可以出现在不同卷版。`facePolicy` 为 `both` 时登记要求留双面，为 `blank` 时登记端明确背面为空白。 |
| `/source/desk` | `request` 是调阅申请，`reserved` 是已确认留用，`received` 是实际收件。`returned` 可以只有部分面。`return_dispute` 是未了退件争议。`release` 是原接收点确认解除实体纸占用。`custody` 是实体归柜记录。 |
| `/source/rescans` | `visit` 给出班组可到的柜点、作业时段及本趟扫描面数。`accepted` 为班组已受理的纸件及面。`cancel_requested` 是取消请求，`released` 是班组实际确认释放。 |

扫描的 `face` 有 `front`、`back` 和 `separator`，`tag` 为空指页签到达时不可读。`artifact` 是 PBM 原图文件名，`imageId` 是扫描事件中的影像编号。`correction` 记录扫描方对某幅既有影像的实体归属复核。`refersTo` 是复核引用的影像编号。卷登记中的 `edition` 与扫描批次编号各自独立。页签由扫描人员记录。

调阅端的 `batch` 是电子页接收单，`physical` 列出指定卷版中的实体页，`mode` 为 `partial` 或 `together`，`deadline` 是接收截止时刻。每条记录内的时刻都采用同一工作日的柜点本地时间，时段含开始且截至结束时刻前。

查询参数 `offset` 从零开始，`limit` 默认 3，允许 1 至 100。响应的 `records` 中，`record` 是来源记录键，`availableFrom` 是首次可查阶段，`kind` 是记录种类，`payload` 是业务内容。`next` 给出下一页偏移，末页返回 `null`。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段。已出现的记录继续可查。用 `GET /original/文件名` 领取原图，阶段内尚不可领时返回 404。来源索引记录原件名称、出现阶段及 SHA-256。

## 处理工具

`src/` 下是一套持续处理上述来源的工具，只使用 Node.js 自带运行库：

- `src/engine.mjs` — 处理引擎。按回放阶段吸收四类来源记录，维护影像归属、卷版齐备、调阅流转、补扫排程与交付历史。
- `src/client.mjs` — 来源客户端，分页拉取全部记录。
- `src/service.mjs` — 调卷查询 HTTP 服务，持续轮询来源。
- `src/cli.mjs` — 命令行入口。

```sh
node src/cli.mjs once  --source http://127.0.0.1:4100              # 拉取一次并打印处理摘要
node src/cli.mjs serve --source http://127.0.0.1:4100 --port 4200  # 持续轮询并提供查询接口
```

### 处理约定

- 卡纸时只有作业报告 `discharged` 确认的位置才算完成；`reverse` 批次按 `frontJob` 的逆序对应正面。
- 影像归属依次按扫描登记、页签（换页影像按 `edition` 对版）、进纸结构判定；页签不清或多候选时留待核，不塞进任何一卷。`correction` 直接改写实体归属，`replaces` 只让旧影像退场。
- 分卷清单按 `facePolicy` 判定必扫面；多卷共用同一张纸时分别判断各自版本是否齐备。
- 电子页 `partial` 齐备一件送一件，`together` 等整组齐备才交；每次交付保留当时的卷版与影像面。影像经复核改属别卷时，旧交付保留并标记作废，同时指明由哪个接收点核对哪张纸。
- 接收点确认释放（`release`）后原纸才可重新安排；归还待核实或在借的原纸不排进现场作业。已接单的补扫在确认释放前仍占趟次，取消请求不释放时段。
- 排程优先仍来得及按时齐备的收件批次；同一张实体纸只安排一次扫描，可分别服务多卷多批次。

### 查询接口

| GET 路由 | 内容 |
| --- | --- |
| `/` | 阶段与处理概览 |
| `/batches`、`/batches/:id` | 各批次当前可收的页、整组等待的卷及缺件 |
| `/gaps` | 缺口、待核候选与预计下一次可核对时刻 |
| `/schedule` | 补扫趟次、排程与调阅占用 |
| `/deliveries` | 交付历史（含已更正的旧交付及当时依据） |
| `/volumes/:id`、`/desks/:id`、`/physicals/:id` | 按卷、接收点、实体纸追溯来源与流转依据 |
| `/events` | 处理事件流水 |

`POST /refresh` 立即轮询来源。
