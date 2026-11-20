// 来源服务客户端：分页拉取 scanner / clerk / desk / rescans 全部记录。
// 只依赖全局 fetch，引擎通过 ingest() 吸收结果。

export async function fetchOverview(baseUrl) {
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) throw new Error(`来源概览请求失败：${response.status}`);
  return response.json();
}

export async function fetchSourceRecords(baseUrl, name, { limit = 100 } = {}) {
  const records = [];
  let offset = 0;
  do {
    const response = await fetch(`${baseUrl}/source/${name}?offset=${offset}&limit=${limit}`);
    if (!response.ok) throw new Error(`来源 ${name} 请求失败：${response.status}`);
    const page = await response.json();
    records.push(...page.records);
    offset = page.next;
  } while (offset !== null);
  return records;
}

// 返回 [{ source, entry }]，按来源索引顺序、来源内记录顺序排列
export async function fetchAllRecords(baseUrl) {
  const overview = await fetchOverview(baseUrl);
  const all = [];
  for (const name of overview.sources) {
    const records = await fetchSourceRecords(baseUrl, name);
    for (const entry of records) all.push({ source: name, entry });
  }
  return { stage: overview.stage, records: all };
}
