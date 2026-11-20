// 转关纸档扫描与调阅处理引擎。
// 按回放阶段吸收 scanner / clerk / desk / rescans 四处来源记录，
// 维护影像归属、卷版齐备、调阅流转、补扫排程与交付历史。
// 引擎本身不联网：来源记录由 client 拉取后送入 ingest()。

const POLICY_FACES = { both: ['front', 'back'], blank: ['front'] };
const FACE_LABEL = { front: '正面', back: '背面', separator: '隔页' };

export function toMinutes(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + m;
}

// 时段含开始、截至结束时刻前：[a0, a1) 与 [b0, b1) 是否相交
export function windowOverlaps(a, b) {
  return toMinutes(a[0]) < toMinutes(b[1]) && toMinutes(b[0]) < toMinutes(a[1]);
}

const key2 = (a, b) => `${a}|${b}`;

export class ArchiveEngine {
  constructor() {
    this.stage = 0;
    this.seq = 0;
    this.seen = new Set();
    // 扫描来源
    this.images = new Map(); // imageId -> 影像
    this.feeds = new Map(); // 站点/批次 -> 作业报告
    this.corrections = []; // 归属复核（按出现顺序）
    this.appliedCorrections = 0;
    // 登记来源
    this.manifests = []; // 分卷清单（卷+版）
    // 调阅来源
    this.loans = new Map();
    this.batches = new Map();
    this.physicalLog = new Map(); // 实体纸 -> 流转事件
    this.disputes = [];
    // 补扫来源
    this.visits = new Map();
    this.bookings = new Map(); // 趟次/实体纸 -> 接单
    // 产出
    this.deliveries = [];
    this.deliverySeq = 0;
    this.pendingVerifications = [];
    this.events = [];
    // 派生状态（每次 settle 重算）
    this.current = new Map(); // 实体纸|面 -> 当前有效影像
    this.completeness = new Map(); // 卷@版 -> 齐备情况
    this.whereabouts = new Map(); // 实体纸 -> 去向
    this.feedNotes = []; // 作业结构备注（缺图、卡纸漏扫等）
    this.plan = { covered: [], assignments: [], unscheduled: [], visits: [] };
  }

  // ---- 记录吸收 ----------------------------------------------------------

  // records: [{ source, entry }]，entry 为来源记录 { record, availableFrom, kind, payload }
  // 同一批记录按回放阶段分组，逐阶段结算，保证“当时依据”可回查。
  ingest(records) {
    const fresh = [];
    for (const { source, entry } of records) {
      if (!entry || this.seen.has(entry.record)) continue;
      this.seen.add(entry.record);
      fresh.push({ source, entry });
    }
    const byStage = new Map();
    for (const item of fresh) {
      const s = item.entry.availableFrom;
      if (!byStage.has(s)) byStage.set(s, []);
      byStage.get(s).push(item);
    }
    for (const s of [...byStage.keys()].sort((a, b) => a - b)) {
      for (const item of byStage.get(s)) this.applyRaw(item.source, item.entry);
      this.settle(s);
    }
    return { stage: this.stage, newRecords: fresh.length };
  }

  applyRaw(source, entry) {
    const { kind, payload, record, availableFrom: stage } = entry;
    if (source === 'scanner') {
      if (kind === 'face') this.addFace(payload, stage, record);
      else if (kind === 'feed') this.addFeed(payload, stage);
      else if (kind === 'correction') this.corrections.push({ ...payload, stage, record });
    } else if (source === 'clerk') {
      if (kind === 'volume') this.manifests.push({ ...payload, stage });
    } else if (source === 'desk') {
      this.applyDesk(kind, payload, stage);
    } else if (source === 'rescans') {
      this.applyRescan(kind, payload, stage);
    }
  }

  addFace(p, stage, record) {
    const img = {
      imageId: p.imageId,
      artifact: p.artifact ?? null,
      face: p.face,
      tag: p.tag ?? null,
      station: p.station,
      job: p.job,
      position: p.position,
      edition: p.edition ?? null,
      purpose: p.purpose ?? null,
      replaces: p.replaces ?? null,
      declaredPhysical: p.physical ?? null,
      physical: null,
      basis: null,
      tentative: false,
      pending: null, // 待核候选 [{ physical, basis }]
      history: [],
      confirmed: false,
      supersededBy: null,
      corrected: false,
      resolved: false,
      stage,
      seq: ++this.seq,
      record,
    };
    if (img.face === 'separator') img.resolved = true; // 隔页只作批次边界，不参与归属
    this.images.set(img.imageId, img);
  }

  addFeed(p, stage) {
    this.feeds.set(key2(p.station, p.job), {
      station: p.station,
      job: p.job,
      mode: p.mode,
      frontJob: p.frontJob ?? null,
      discharged: new Set(p.discharged ?? []),
      jamAfter: p.jamAfter ?? null,
      stage,
    });
  }

  applyDesk(kind, p, stage) {
    const loanOf = (id) => {
      if (!this.loans.has(id)) {
        this.loans.set(id, { loan: id, desk: p.desk ?? null, volume: null, edition: null, window: null, reserved: null, received: [], returned: [], releases: [] });
      }
      return this.loans.get(id);
    };
    if (kind === 'request') {
      Object.assign(loanOf(p.loan), { desk: p.desk, volume: p.volume, edition: p.edition, window: p.window });
    } else if (kind === 'reserved') {
      const loan = loanOf(p.loan);
      Object.assign(loan, { desk: p.desk, volume: p.volume, edition: p.edition, window: p.window });
      loan.reserved = { physicals: p.physical ?? [], confirmedAt: p.confirmedAt, window: p.window };
    } else if (kind === 'received') {
      const loan = loanOf(p.loan);
      loan.received.push({ physical: p.physical, faces: p.faces ?? [], time: p.time, issue: null });
      this.logPhysical(p.physical, { type: 'received', desk: p.desk, loan: p.loan, time: p.time, stage });
    } else if (kind === 'returned') {
      const loan = loanOf(p.loan);
      loan.returned.push({ physical: p.physical, faces: p.faces ?? [], time: p.time });
      this.logPhysical(p.physical, { type: 'returned', desk: p.desk, loan: p.loan, faces: p.faces ?? [], time: p.time, stage });
    } else if (kind === 'return_dispute') {
      this.disputes.push({ loan: p.loan, desk: p.desk, physical: p.physical, face: p.face, imageId: p.imageId, time: p.time, stage });
    } else if (kind === 'release') {
      const loan = loanOf(p.loan);
      loan.releases.push({ physical: p.physical, time: p.time, location: p.location });
      this.logPhysical(p.physical, { type: 'release', desk: p.desk, loan: p.loan, location: p.location, time: p.time, stage });
    } else if (kind === 'custody') {
      this.logPhysical(p.physical, { type: 'custody', location: p.location, time: p.time, stage });
    } else if (kind === 'batch') {
      this.batches.set(p.batch, {
        batch: p.batch, desk: p.desk, volume: p.volume, edition: p.edition,
        physicals: p.physical ?? [], mode: p.mode, deadline: p.deadline, stage, items: [],
      });
    }
  }

  applyRescan(kind, p, stage) {
    if (kind === 'visit') {
      this.visits.set(p.visit, { visit: p.visit, location: p.location, window: p.window, faceLimit: p.faceLimit, stage });
    } else if (kind === 'accepted') {
      this.bookings.set(key2(p.visit, p.physical), {
        visit: p.visit, physical: p.physical, faces: p.faces ?? [],
        acceptedAt: p.time, cancelRequestedAt: null, releasedAt: null, stage,
      });
    } else if (kind === 'cancel_requested') {
      const b = this.bookings.get(key2(p.visit, p.physical));
      // 取消请求不释放时段：接单在确认释放前仍占着趟次
      if (b) b.cancelRequestedAt = p.time;
    } else if (kind === 'released') {
      const b = this.bookings.get(key2(p.visit, p.physical));
      if (b) b.releasedAt = p.time;
    }
  }

  logPhysical(physical, event) {
    if (!this.physicalLog.has(physical)) this.physicalLog.set(physical, []);
    this.physicalLog.get(physical).push(event);
  }

  log(stage, message) {
    this.events.push({ stage, message });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  // ---- 阶段结算 ----------------------------------------------------------

  settle(stage) {
    this.stage = Math.max(this.stage, stage);
    this.confirmImages();
    this.resolveImages();
    this.applyCorrections();
    this.applySupersession();
    this.computeCurrent();
    this.computeCompleteness();
    this.computeWhereabouts();
    this.computeDeliveries(stage);
    this.invalidateDeliveries();
    this.computeFeedNotes();
    this.plan = this.computePlan();
  }

  // 卡纸时只有报告确认稳定出纸的位置才算完成
  confirmImages() {
    for (const img of this.images.values()) {
      const feed = this.feeds.get(key2(img.station, img.job));
      img.confirmed = Boolean(feed && feed.discharged.has(img.position));
    }
  }

  manifestsAt(stage) {
    return this.manifests.filter((m) => m.stage <= stage);
  }

  // 页签 -> 实体纸：按影像出现阶段已知的分卷清单判定；换页影像带 edition 时优先对版
  tagToPhysicals(tag, edition, stage) {
    const collect = (withEdition) => {
      const found = new Set();
      for (const m of this.manifestsAt(stage)) {
        if (withEdition && edition && m.edition !== edition) continue;
        for (const leaf of m.leaves) if (leaf.tag === tag) found.add(leaf.physical);
      }
      return [...found];
    };
    const exact = collect(true);
    return exact.length ? exact : collect(false);
  }

  imageAt(station, job, position) {
    for (const img of this.images.values()) {
      if (img.station === station && img.job === job && img.position === position) return img;
    }
    return null;
  }

  // 结构归属：双面连续扫描的正背配对；翻转补扫按正面批次的逆序对应
  structuralCandidate(img) {
    const feed = this.feeds.get(key2(img.station, img.job));
    if (!feed || img.face !== 'back') return null;
    if (feed.mode === 'duplex') {
      const partner = this.imageAt(img.station, img.job, img.position - 1);
      if (partner && partner.face === 'front' && partner.physical) {
        return { physical: partner.physical, basis: `双面对应（${partner.imageId}）` };
      }
    }
    if (feed.mode === 'reverse' && feed.frontJob) {
      const frontFeed = this.feeds.get(key2(img.station, feed.frontJob));
      if (frontFeed && frontFeed.discharged.size) {
        const n = Math.max(...frontFeed.discharged);
        const frontPos = n - img.position + 1;
        const partner = this.imageAt(img.station, feed.frontJob, frontPos);
        if (partner && partner.physical) {
          return { physical: partner.physical, basis: `翻转对应（${feed.frontJob} 第 ${frontPos} 位 ${partner.imageId}）` };
        }
      }
    }
    return null;
  }

  // 归属判定：扫描登记 > 页签/结构；多候选或冲突时留待核，不塞进任何一卷
  resolveImages() {
    const finish = (img) => {
      if (img.physical || img.pending) {
        img.resolved = true;
        if (img.physical) img.history.push({ stage: img.stage, physical: img.physical, basis: img.basis });
      }
    };
    // 第一遍：扫描登记与页签可以直接判定的影像
    for (const img of this.images.values()) {
      if (img.resolved) continue;
      if (img.declaredPhysical) {
        img.physical = img.declaredPhysical;
        img.basis = '扫描登记';
      } else if (img.tag) {
        const ps = this.tagToPhysicals(img.tag, img.edition, img.stage);
        if (ps.length === 1) {
          img.physical = ps[0];
          img.basis = img.edition ? `页签+版次 ${img.edition}` : '页签';
        } else {
          img.pending = ps.length
            ? ps.map((p) => ({ physical: p, basis: '页签' })) // 页签对应多张实体纸：待核
            : []; // 页签对不上任何登记：归属不明
        }
      } else {
        continue; // 页签不清，留待结构判定
      }
      finish(img);
    }
    // 第二遍：页签不清或页签存疑的影像按结构对应判定
    for (const img of this.images.values()) {
      if (img.resolved) continue;
      const structural = this.structuralCandidate(img);
      if (structural) {
        if (!img.pending) {
          img.physical = structural.physical;
          img.basis = structural.basis;
          img.tentative = true; // 仅结构单一候选：暂定归属
        } else if (img.pending.length === 0) {
          img.physical = structural.physical;
          img.basis = structural.basis;
          img.tentative = true;
          img.pending = null;
        } else if (img.pending.some((c) => c.physical === structural.physical)) {
          img.physical = structural.physical; // 结构命中页签候选之一：收敛
          img.basis = `${structural.basis}+页签`;
          img.pending = null;
        } else {
          img.pending = [...img.pending, structural]; // 页签与结构冲突：待核
        }
      } else if (!img.pending) {
        img.pending = []; // 无任何线索：归属不明
      }
      finish(img);
    }
  }

  // 扫描方复核：直接改写实体归属（即使影像已被取代，也保留其历史归属）
  applyCorrections() {
    for (; this.appliedCorrections < this.corrections.length; this.appliedCorrections += 1) {
      const c = this.corrections[this.appliedCorrections];
      const img = this.images.get(c.imageId);
      if (!img) continue;
      img.physical = c.physical;
      img.basis = `复核更正（${c.reason ?? '原因未注明'}，参照 ${c.refersTo ?? '无'}）`;
      img.corrected = true;
      img.tentative = false;
      img.pending = null;
      img.history.push({ stage: c.stage, physical: c.physical, basis: img.basis });
      this.log(c.stage, `影像 ${c.imageId} 经复核归属 ${c.physical}（${c.reason ?? ''}）`);
    }
  }

  // 补扫取代：replaces 只让旧影像退场，新影像按自身线索归属
  applySupersession() {
    for (const img of this.images.values()) {
      if (!img.replaces) continue;
      const old = this.images.get(img.replaces);
      if (old && !old.supersededBy) old.supersededBy = img.imageId;
    }
  }

  // 每个（实体纸, 面）的当前有效影像：确认出纸、未退场，取最新
  computeCurrent() {
    const current = new Map();
    for (const img of this.images.values()) {
      if (!img.confirmed || !img.physical || img.supersededBy || img.face === 'separator') continue;
      const key = key2(img.physical, img.face);
      const prev = current.get(key);
      if (!prev || img.stage > prev.stage || (img.stage === prev.stage && img.seq > prev.seq)) {
        current.set(key, img);
      }
    }
    this.current = current;
  }

  computeCompleteness() {
    const result = new Map();
    for (const m of this.manifests) {
      const leaves = m.leaves.map((leaf) => {
        const required = POLICY_FACES[leaf.facePolicy] ?? ['front'];
        const faces = {};
        const missing = [];
        for (const face of required) {
          const img = this.current.get(key2(leaf.physical, face));
          faces[face] = img ? img.imageId : null;
          if (!img) missing.push(face);
        }
        return { ...leaf, required, faces, missing };
      });
      result.set(`${m.volume}@${m.edition}`, {
        volume: m.volume, edition: m.edition, stage: m.stage, leaves,
        complete: leaves.every((l) => l.missing.length === 0),
      });
    }
    this.completeness = result;
  }

  // 实体纸去向：以时间最晚的流转事件为准；只有接收点确认释放后才可重新安排
  computeWhereabouts() {
    const result = new Map();
    for (const [physical, events] of this.physicalLog) {
      const sorted = [...events].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
      const last = sorted[sorted.length - 1];
      let state;
      if (last.type === 'custody' || last.type === 'release') {
        state = { free: true, status: '在库', location: last.location, since: last.time };
      } else if (last.type === 'received') {
        state = { free: false, status: '借出中', desk: last.desk, loan: last.loan, since: last.time };
      } else {
        state = { free: false, status: '归还待核实', desk: last.desk, loan: last.loan, since: last.time };
      }
      const occupations = [];
      for (const loan of this.loans.values()) {
        if (loan.reserved?.physicals.includes(physical)) {
          occupations.push({ type: '留用', loan: loan.loan, desk: loan.desk, window: loan.reserved.window, confirmed: true });
        } else if (!loan.reserved && !loan.received.length && loan.window && loan.volume) {
          // 尚在审批的申请只作排程参考
          const manifest = this.manifests.find((m) => m.volume === loan.volume && m.edition === loan.edition);
          if (manifest?.leaves.some((l) => l.physical === physical)) {
            occupations.push({ type: '申请参考', loan: loan.loan, desk: loan.desk, window: loan.window, confirmed: false });
          }
        }
      }
      result.set(physical, { physical, ...state, occupations, timeline: sorted });
    }
    this.whereabouts = result;
  }

  manifestOf(volume, edition) {
    return this.manifests.find((m) => m.volume === volume && m.edition === edition) ?? null;
  }

  openDelivery(batchId, physical) {
    return this.deliveries.find((d) => d.kind === '电子页' && d.batch === batchId && d.physical === physical && !d.invalidated) ?? null;
  }

  // 电子页交付：partial 齐备一件送一件；together 等整组齐备才交
  computeDeliveries(stage) {
    for (const batch of this.batches.values()) {
      const manifest = this.manifestOf(batch.volume, batch.edition);
      if (!manifest) continue;
      batch.items = batch.physicals.map((physical) => {
        const leaf = manifest.leaves.find((l) => l.physical === physical) ?? null;
        const required = leaf ? (POLICY_FACES[leaf.facePolicy] ?? ['front']) : ['front'];
        const images = {};
        let complete = Boolean(leaf);
        for (const face of required) {
          const img = this.current.get(key2(physical, face)) ?? null;
          images[face] = img;
          if (!img) complete = false;
        }
        return { physical, leaf, required, images, complete };
      });
      const deliverItem = (item) => {
        const delivery = {
          id: `D${++this.deliverySeq}`,
          kind: '电子页',
          batch: batch.batch,
          desk: batch.desk,
          volume: batch.volume,
          edition: batch.edition,
          physical: item.physical,
          faces: Object.fromEntries(Object.entries(item.images).map(([f, i]) => [f, i.imageId])),
          images: Object.values(item.images).map((i) => ({ imageId: i.imageId, artifact: i.artifact })),
          basis: { volume: batch.volume, edition: batch.edition, tag: item.leaf?.tag ?? null, facePolicy: item.leaf?.facePolicy ?? null },
          stage,
          invalidated: null,
        };
        this.deliveries.push(delivery);
        this.log(stage, `批次 ${batch.batch} 向 ${batch.desk} 交付 ${item.physical}（${Object.values(delivery.faces).join('、')}）`);
      };
      if (batch.mode === 'partial') {
        for (const item of batch.items) if (item.complete && !this.openDelivery(batch.batch, item.physical)) deliverItem(item);
      } else if (batch.items.every((i) => i.complete)) {
        for (const item of batch.items) if (!this.openDelivery(batch.batch, item.physical)) deliverItem(item);
      }
    }
  }

  // 交付作废旧不抹除：影像经复核改属别卷时，当时交付保留、标记作废并指明待核对象
  invalidateDeliveries() {
    for (const d of this.deliveries) {
      if (d.invalidated) continue;
      for (const [face, imageId] of Object.entries(d.faces)) {
        const img = this.images.get(imageId);
        if (!img || img.physical !== d.physical) {
          d.invalidated = {
            stage: this.stage, face, imageId,
            reason: `影像 ${imageId} 经复核归属 ${img?.physical ?? '未知'}，不再属于 ${d.physical}`,
          };
          this.pendingVerifications.push({
            desk: d.desk, physical: d.physical, face, imageId, batch: d.batch ?? null, loan: null,
            note: `请 ${d.desk} 核对 ${d.physical} 的${FACE_LABEL[face] ?? face}实体纸`, stage: this.stage,
          });
          this.log(this.stage, `交付 ${d.id}（${d.physical}）因影像 ${imageId} 更正而作废，保留当时依据备查`);
          break;
        }
      }
    }
    // 实体签收同样受复核影响：已交出的纸不能当成仍在库里
    for (const loan of this.loans.values()) {
      for (const rcpt of loan.received) {
        if (rcpt.issue) continue;
        for (const imageId of rcpt.faces) {
          const img = this.images.get(imageId);
          if (img && img.physical && img.physical !== rcpt.physical) {
            rcpt.issue = `影像 ${imageId} 经复核归属 ${img.physical}`;
            this.pendingVerifications.push({
              desk: loan.desk, physical: rcpt.physical, face: img.face, imageId, batch: null, loan: loan.loan,
              note: `请 ${loan.desk} 核对 ${rcpt.physical} 实体纸（调阅 ${loan.loan}）`, stage: this.stage,
            });
            this.log(this.stage, `调阅 ${loan.loan} 签收 ${rcpt.physical} 的影像 ${imageId} 经复核改属 ${img.physical}`);
          }
        }
      }
    }
  }

  // 作业结构备注：确认出纸却无影像、卡纸漏扫的背面等
  computeFeedNotes() {
    const notes = [];
    for (const feed of this.feeds.values()) {
      for (const pos of [...feed.discharged].sort((a, b) => a - b)) {
        if (!this.imageAt(feed.station, feed.job, pos)) {
          notes.push({ type: '缺图', station: feed.station, job: feed.job, position: pos, note: '出纸确认但无影像，归属待核' });
        }
      }
      if (feed.mode === 'duplex') {
        for (const img of this.images.values()) {
          if (img.station === feed.station && img.job === feed.job && img.face === 'front' && !feed.discharged.has(img.position + 1)) {
            notes.push({ type: '背面未扫', station: feed.station, job: feed.job, position: img.position, physical: img.physical ?? null, note: `卡纸边界 ${feed.jamAfter ?? '?'} 后未出纸` });
          }
        }
      }
      if (feed.mode === 'reverse' && feed.frontJob) {
        const frontFeed = this.feeds.get(key2(feed.station, feed.frontJob));
        if (frontFeed && frontFeed.discharged.size) {
          const n = Math.max(...frontFeed.discharged);
          for (const fp of [...frontFeed.discharged].sort((a, b) => a - b)) {
            const revPos = n - fp + 1;
            if (!feed.discharged.has(revPos)) {
              const front = this.imageAt(feed.station, feed.frontJob, fp);
              notes.push({
                type: '背面未扫', station: feed.station, job: feed.job, position: revPos,
                physical: front?.physical ?? null,
                note: `翻转补扫在第 ${revPos} 位前卡纸（对应 ${feed.frontJob} 第 ${fp} 位正面）`,
              });
            }
          }
        }
      }
    }
    this.feedNotes = notes;
  }

  activeBookings() {
    return [...this.bookings.values()].filter((b) => !b.releasedAt);
  }

  visitUsedFaces(visitId) {
    return this.activeBookings()
      .filter((b) => b.visit === visitId)
      .reduce((sum, b) => sum + b.faces.length, 0);
  }

  // 补扫排程：缺口 -> 可达趟次。已确认调阅占用原纸；去向未核实不排程；
  // 同一张实体纸只安排一次扫描，可分别服务多卷/多批次。
  computePlan() {
    const needs = new Map();
    for (const batch of this.batches.values()) {
      for (const item of batch.items ?? []) {
        if (this.openDelivery(batch.batch, item.physical)) continue;
        for (const face of item.required) {
          if (item.images[face]) continue;
          const key = key2(item.physical, face);
          if (!needs.has(key)) needs.set(key, { physical: item.physical, face, consumers: [] });
          needs.get(key).consumers.push({ batch: batch.batch, desk: batch.desk, deadline: batch.deadline });
        }
      }
    }
    const covered = [];
    const assignments = [];
    const unscheduled = [];
    const plannedPerVisit = new Map();
    const sorted = [...needs.values()].sort((a, b) =>
      Math.min(...a.consumers.map((c) => toMinutes(c.deadline))) - Math.min(...b.consumers.map((c) => toMinutes(c.deadline))));
    for (const need of sorted) {
      const splitConsumers = (readyAt) => ({
        onTime: need.consumers.filter((c) => toMinutes(readyAt) <= toMinutes(c.deadline)),
        late: need.consumers.filter((c) => toMinutes(readyAt) > toMinutes(c.deadline)),
      });
      // 已接单的补扫仍占着时段，直接作为该缺口的落实安排
      const booking = this.activeBookings().find((b) => b.physical === need.physical && b.faces.includes(need.face));
      if (booking) {
        const visit = this.visits.get(booking.visit);
        covered.push({ ...need, visit: booking.visit, window: visit?.window ?? null, readyAt: visit?.window[1] ?? null, via: booking.cancelRequestedAt ? '已接单（取消待确认）' : '已接单', ...splitConsumers(visit?.window[1] ?? '99:99') });
        continue;
      }
      const wb = this.whereabouts.get(need.physical);
      if (!wb) {
        unscheduled.push({ ...need, reason: '原纸无归柜记录，去向不明，保留缺口' });
        continue;
      }
      if (!wb.free) {
        unscheduled.push({
          ...need,
          reason: wb.status === '借出中'
            ? `原纸在借（${wb.desk}，调阅 ${wb.loan}），待归还核实`
            : `归还待 ${wb.desk} 核实，暂不排程`,
          nextCheck: wb.status === '借出中' ? `等待归还或调阅窗口结束` : `等待 ${wb.desk} 确认释放`,
          // 原纸自 since 起不在柜，截止早于该时刻的消费者已无法按时齐备
          late: need.consumers.filter((c) => toMinutes(c.deadline) < toMinutes(wb.since)),
        });
        continue;
      }
      const feasible = [...this.visits.values()].filter((v) => {
        if (v.location !== wb.location) return false;
        if (toMinutes(v.window[0]) < toMinutes(wb.since)) return false;
        if (wb.occupations.some((o) => o.confirmed && windowOverlaps(o.window, v.window))) return false;
        if (this.visitUsedFaces(v.visit) + (plannedPerVisit.get(v.visit) ?? 0) >= v.faceLimit) return false;
        // 同一实体纸在别的趟次已有未释放接单时，不重复安排
        return !this.activeBookings().some((b) => {
          if (b.physical !== need.physical) return false;
          const bv = this.visits.get(b.visit);
          return bv && windowOverlaps(bv.window, v.window);
        });
      }).sort((a, b) => toMinutes(a.window[1]) - toMinutes(b.window[1]));
      if (!feasible.length) {
        unscheduled.push({ ...need, reason: '无可达柜点/时段或趟次面数不足的班组' });
        continue;
      }
      const visit = feasible[0];
      plannedPerVisit.set(visit.visit, (plannedPerVisit.get(visit.visit) ?? 0) + 1);
      assignments.push({
        ...need, visit: visit.visit, location: visit.location, window: visit.window,
        readyAt: visit.window[1], via: '新排程', ...splitConsumers(visit.window[1]),
      });
    }
    const visits = [...this.visits.values()].map((v) => {
      const bookings = this.activeBookings().filter((b) => b.visit === v.visit);
      return {
        ...v,
        bookedFaces: this.visitUsedFaces(v.visit),
        plannedFaces: plannedPerVisit.get(v.visit) ?? 0,
        bookings: bookings.map((b) => ({ physical: b.physical, faces: b.faces, acceptedAt: b.acceptedAt, cancelRequestedAt: b.cancelRequestedAt })),
      };
    });
    return { covered, assignments, unscheduled, visits };
  }

  // ---- 查询投影 ----------------------------------------------------------

  overview() {
    return {
      stage: this.stage,
      images: this.images.size,
      manifests: this.manifests.length,
      batches: this.batches.size,
      loans: this.loans.size,
      visits: this.visits.size,
      deliveries: this.deliveries.length,
      openNeeds: this.plan.assignments.length + this.plan.unscheduled.length,
      pendingVerifications: this.pendingVerifications.length,
      ambiguities: this.ambiguities().length,
    };
  }

  ambiguities() {
    const list = [];
    for (const img of this.images.values()) {
      if (img.pending) {
        list.push({
          type: '归属待核', imageId: img.imageId, artifact: img.artifact, face: img.face,
          candidates: img.pending.length ? img.pending : '无任何归属线索',
          note: '不因某卷缺页就直接塞入，待扫描方或登记端复核',
        });
      }
    }
    for (const note of this.feedNotes) {
      if (note.type === '缺图') list.push({ ...note, type: '缺图待核' });
    }
    return list;
  }

  batchView(id) {
    const batch = this.batches.get(id);
    if (!batch) return null;
    const items = batch.items.map((item) => {
      const open = this.openDelivery(id, item.physical);
      const history = this.deliveries.filter((d) => d.batch === id && d.physical === item.physical);
      const last = history[history.length - 1] ?? null;
      const missing = item.required.filter((f) => !item.images[f]);
      let status;
      if (open) status = '已交付';
      else if (last?.invalidated) status = '交付已更正，待补送';
      else if (!missing.length) status = batch.mode === 'together' ? '整组等待' : '可交付';
      else status = '缺件待扫';
      const planned = [...this.plan.assignments, ...this.plan.covered]
        .find((a) => a.physical === item.physical && missing.includes(a.face));
      const hold = this.plan.unscheduled
        .find((u) => u.physical === item.physical && missing.includes(u.face));
      return {
        physical: item.physical,
        tag: item.leaf?.tag ?? null,
        required: item.required,
        missing,
        status,
        delivery: open?.id ?? null,
        invalidated: last && !open ? last.invalidated : null,
        planned: planned ? { visit: planned.visit, window: planned.window, readyAt: planned.readyAt, via: planned.via } : null,
        hold: hold ? { reason: hold.reason, nextCheck: hold.nextCheck ?? null } : null,
      };
    });
    const deliveredCount = items.filter((i) => i.status === '已交付').length;
    let status;
    if (deliveredCount === items.length) status = '完成';
    else if (deliveredCount > 0) status = '部分交付';
    else status = batch.mode === 'together' ? '整组等待' : '待交付';
    const late = [...this.plan.assignments, ...this.plan.covered]
      .flatMap((a) => a.late.map((c) => ({ ...c, readyAt: a.readyAt })))
      .concat(this.plan.unscheduled.flatMap((u) => (u.late ?? []).map((c) => ({ ...c, readyAt: null }))))
      .filter((c) => c.batch === id);
    const flags = [];
    if (late.length) flags.push(`无法按时齐备：${late[0].readyAt ? `最早 ${late[0].readyAt} 齐备，` : ''}已过截止 ${late[0].deadline}`);
    if (items.some((i) => i.hold)) flags.push('部分缺件待落实（原纸去向或资源）');
    return {
      batch: batch.batch, desk: batch.desk, volume: batch.volume, edition: batch.edition,
      mode: batch.mode, deadline: batch.deadline, status, flags, items,
    };
  }

  listBatches() {
    return [...this.batches.keys()].map((id) => this.batchView(id));
  }

  volumeView(volume) {
    const editions = [...this.completeness.values()].filter((c) => c.volume === volume);
    if (!editions.length) return null;
    const imageInfo = (imageId) => {
      if (!imageId) return null;
      const img = this.images.get(imageId);
      return img ? { imageId, artifact: img.artifact, basis: img.basis, station: img.station, job: img.job, position: img.position } : null;
    };
    return {
      volume,
      editions: editions.map((e) => ({
        edition: e.edition,
        complete: e.complete,
        leaves: e.leaves.map((l) => ({
          tag: l.tag, physical: l.physical, facePolicy: l.facePolicy, missing: l.missing,
          faces: Object.fromEntries(Object.entries(l.faces).map(([f, id]) => [f, imageInfo(id)])),
        })),
      })),
      loans: [...this.loans.values()].filter((l) => l.volume === volume).map((l) => this.loanSummary(l)),
      batches: [...this.batches.values()].filter((b) => b.volume === volume).map((b) => b.batch),
    };
  }

  loanSummary(loan) {
    const released = new Set(loan.releases.map((r) => r.physical));
    let status;
    if (loan.received.length && loan.received.every((r) => released.has(r.physical))) status = '已释放';
    else if (loan.received.length) status = loan.returned.length ? '部分归还' : '借出中';
    else if (loan.reserved) status = '已确认留用';
    else status = '申请中';
    return {
      loan: loan.loan, desk: loan.desk, volume: loan.volume, edition: loan.edition,
      window: loan.window, status,
      received: loan.received, returned: loan.returned, releases: loan.releases,
      reserved: loan.reserved,
    };
  }

  deskView(desk) {
    const loans = [...this.loans.values()].filter((l) => l.desk === desk);
    const batches = [...this.batches.values()].filter((b) => b.desk === desk);
    if (!loans.length && !batches.length) return null;
    return {
      desk,
      loans: loans.map((l) => this.loanSummary(l)),
      batches: batches.map((b) => this.batchView(b.batch)),
      disputes: this.disputes.filter((d) => d.desk === desk),
      pendingVerifications: this.pendingVerifications.filter((v) => v.desk === desk),
    };
  }

  physicalView(physical) {
    const wb = this.whereabouts.get(physical);
    const images = [...this.images.values()].filter(
      (img) => img.physical === physical || img.history.some((h) => h.physical === physical));
    const manifests = this.manifests.filter((m) => m.leaves.some((l) => l.physical === physical));
    if (!wb && !images.length && !manifests.length) return null;
    return {
      physical,
      whereabouts: wb ? { status: wb.status, location: wb.location ?? null, desk: wb.desk ?? null, loan: wb.loan ?? null, since: wb.since, free: wb.free, occupations: wb.occupations } : null,
      timeline: wb?.timeline ?? [],
      images: images.map((img) => ({
        imageId: img.imageId, artifact: img.artifact, face: img.face,
        current: this.current.get(key2(img.physical, img.face)) === img,
        corrected: img.corrected, tentative: img.tentative, supersededBy: img.supersededBy,
        station: img.station, job: img.job, position: img.position, basis: img.basis, history: img.history,
      })),
      volumes: manifests.map((m) => ({ volume: m.volume, edition: m.edition, tag: m.leaves.find((l) => l.physical === physical)?.tag ?? null })),
      batches: [...this.batches.values()].filter((b) => b.physicals.includes(physical)).map((b) => b.batch),
      bookings: [...this.bookings.values()].filter((b) => b.physical === physical),
      disputes: this.disputes.filter((d) => d.physical === physical),
      pendingVerifications: this.pendingVerifications.filter((v) => v.physical === physical),
    };
  }

  gapsView() {
    const needs = new Map();
    const merge = (entry, state, extra) => {
      const key = key2(entry.physical, entry.face);
      if (!needs.has(key)) needs.set(key, { physical: entry.physical, face: entry.face, consumers: [], state, ...extra });
      needs.get(key).consumers.push(...entry.consumers);
    };
    for (const a of this.plan.assignments) merge(a, '已排程', { visit: a.visit, window: a.window, nextCheck: `${a.visit} ${a.window[0]}-${a.window[1]}` });
    for (const c of this.plan.covered) merge(c, '已接单', { visit: c.visit, window: c.window, nextCheck: `${c.visit} ${c.window?.[0] ?? ''}-${c.window?.[1] ?? ''}` });
    for (const u of this.plan.unscheduled) merge(u, '待落实', { reason: u.reason, nextCheck: u.nextCheck ?? null });
    return {
      gaps: [...needs.values()],
      ambiguities: this.ambiguities(),
      feedNotes: this.feedNotes,
      pendingVerifications: this.pendingVerifications,
    };
  }

  scheduleView() {
    return {
      visits: this.plan.visits,
      assignments: this.plan.assignments,
      covered: this.plan.covered,
      unscheduled: this.plan.unscheduled,
      occupations: [...this.whereabouts.values()].flatMap((wb) =>
        wb.occupations.map((o) => ({ physical: wb.physical, ...o }))),
    };
  }

  deliveriesView() {
    return this.deliveries.map((d) => ({ ...d }));
  }
}
