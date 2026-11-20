#!/usr/bin/env node
// 命令行入口：
//   node src/cli.mjs once   --source http://127.0.0.1:4100   拉取一次并打印处理摘要
//   node src/cli.mjs serve  --source http://127.0.0.1:4100 --port 4200 [--interval 2000]
import { ArchiveEngine } from './engine.mjs';
import { fetchAllRecords } from './client.mjs';
import { createService } from './service.mjs';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'serve';
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i]?.startsWith('--')) flags[args[i].slice(2)] = args[i + 1];
}
const source = flags.source ?? 'http://127.0.0.1:4100';

if (command === 'once') {
  const engine = new ArchiveEngine();
  const { records } = await fetchAllRecords(source);
  engine.ingest(records);
  const summary = {
    概览: engine.overview(),
    批次: engine.listBatches(),
    缺口: engine.gapsView(),
    排程: engine.scheduleView(),
    交付: engine.deliveriesView(),
    事件: engine.events,
  };
  console.log(JSON.stringify(summary, null, 2));
} else if (command === 'serve') {
  const port = Number(flags.port ?? 4200);
  const intervalMs = Number(flags.interval ?? 2000);
  const service = createService({ source, intervalMs });
  const { url } = await service.start({ port });
  console.log(`调卷查询服务 ${url}（来源 ${source}，每 ${intervalMs}ms 轮询）`);
} else {
  console.error(`未知命令：${command}（可用：once / serve）`);
  process.exit(1);
}
