// 调卷查询服务：在引擎之上提供 HTTP 查询接口，并持续轮询来源。
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ArchiveEngine } from './engine.mjs';
import { fetchAllRecords } from './client.mjs';

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createService({ source, engine = new ArchiveEngine(), intervalMs = 2000 } = {}) {
  let lastPoll = null;
  let lastError = null;

  async function refresh() {
    try {
      const { records } = await fetchAllRecords(source);
      const result = engine.ingest(records);
      lastPoll = new Date().toISOString();
      lastError = null;
      return result;
    } catch (error) {
      lastError = error.message;
      throw error;
    }
  }

  const routes = {
    'GET /': () => ({ service: '转关纸档扫描与调阅处理', source, stage: engine.stage, lastPoll, lastError, ...engine.overview() }),
    'GET /batches': () => engine.listBatches(),
    'GET /gaps': () => engine.gapsView(),
    'GET /schedule': () => engine.scheduleView(),
    'GET /deliveries': () => engine.deliveriesView(),
    'GET /events': () => engine.events,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);
    try {
      if (request.method === 'POST' && path === '/refresh') {
        sendJson(response, 200, await refresh());
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '仅支持读取与 /refresh' });
        return;
      }
      if (routes[`GET ${path}`]) {
        sendJson(response, 200, routes[`GET ${path}`]());
        return;
      }
      let match = /^\/batches\/([\w-]+)$/.exec(path);
      if (match) {
        const view = engine.batchView(match[1]);
        return sendJson(response, view ? 200 : 404, view ?? { error: '未找到批次' });
      }
      match = /^\/volumes\/([\w-]+)$/.exec(path);
      if (match) {
        const view = engine.volumeView(match[1]);
        return sendJson(response, view ? 200 : 404, view ?? { error: '未找到卷' });
      }
      match = /^\/desks\/([\w一-鿿-]+)$/.exec(path);
      if (match) {
        const view = engine.deskView(match[1]);
        return sendJson(response, view ? 200 : 404, view ?? { error: '未找到接收点' });
      }
      match = /^\/physicals\/([\w-]+)$/.exec(path);
      if (match) {
        const view = engine.physicalView(match[1]);
        return sendJson(response, view ? 200 : 404, view ?? { error: '未找到实体纸' });
      }
      sendJson(response, 404, { error: '未找到查询' });
    } catch (error) {
      sendJson(response, 500, { error: `查询失败：${error.message}` });
    }
  });

  let timer = null;
  return {
    server,
    engine,
    refresh,
    async start({ port = 0, host = '127.0.0.1' } = {}) {
      await refresh();
      if (intervalMs > 0) {
        timer = setInterval(() => refresh().catch(() => {}), intervalMs);
        timer.unref();
      }
      server.listen(port, host);
      await once(server, 'listening');
      return { url: `http://${host}:${server.address().port}` };
    },
    async stop() {
      if (timer) clearInterval(timer);
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
