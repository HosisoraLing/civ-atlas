/**
 * 助手面板(右上「助手」按钮打开;手机是右上第三个按钮,一张拉到顶的底部卡片)。状态在 assistantStore.ts。
 *
 *   顶上        "助手" + 用的是哪家的哪个模型;新对话、收起
 *   空的时候    一段说明 + 五句按这个世界写的例子(点一下填进输入框);没设置 AI 时多一行"设置 AI"
 *   一轮对话    作者的话 → 助手做的每一步(做完打勾、正在做转圈、没做成灰叉;做完收成一行,点开看)→ 回的话
 *              (说到的国家、城是蓝字,点了在地图上打开)→ 做不到的 → 确认单(要改的几条,能勾掉;试推演的结果和现在比)
 *              → 执行 / 先在地图上看看 / 不要;问答下面列说到的大事(点了时间轴跳过去);写史书一行进度;起名列候选
 *   底下        输入框(回车发送,Shift + 回车换行);助手在做时右下是停止;世界正在重推时上面一行"世界正在重推,好了再说"
 * 先在地图上看看:地图、左边卡片、时间轴换成试推演的历史(App 换),地图上方一条提示(PreviewBanner),能直接执行或回到现在。
 * 宽屏面板在右边、和左边的世界卡片对称(窗口够宽时地图往左让,见 astPanel.ts);手机往下拉或点 ✕ 收起,对话留着。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { buildChronicle, type ChronicleEntry } from '../gen/civ/chronicle';
import { capitalAt, polityAlive, polityAllTitles, polityName } from '../gen/civ/growth';
import { openAiSettings, useAiStatus } from '../ai/client';
import { stepsSummary, type TrialRow, type TrialView } from '../ai/agent/assistant';
import { WISH_MAX, type RewriteLock } from '../ai/prompts/rewrite';
import { bookProgress, bookUnit, openBookReader, useBook } from './bookStore';
import { getCivTime, pickChronicleEntry, setSelection, useSelection, type MapSelection } from './civView';
import { useEdits } from './editsStore';
import { requestFly } from './panelStore';
import { useSavesVersion } from './saveStore';
import { closeAssistant } from './astPanel';
import {
  applyBlock,
  applyProposal,
  dismissProposal,
  exitPreview,
  newConversation,
  pickName,
  pickedChanges,
  previewBlock,
  previewProposal,
  previewable,
  sendAsk,
  stopAsk,
  syncAssistantWorld,
  toggleItem,
  undoProposal,
  useAssistant,
  type AsStep,
  type AsTurn,
} from './assistantStore';
import { Icon } from './icons';
import './assistant.css';

const TERRAIN_OPS = ['volcano', 'lake', 'range', 'raise', 'sink'];

const HINT: Record<RewriteLock | 'none', string> = {
  none: '我能查这个世界的历史，改之前先在后台把历史推一遍、看结果对不对，也能写史书、起名。要改世界的地方，都会先列出来给你确认。',
  terrain: '我能查这个世界的历史，改之前先在后台把历史推一遍、看结果对不对，也能写史书、起名。要改世界的地方，都会先列出来给你确认。',
  history: '说说想把这颗星球改成什么样，我先在星球上圈出要改的地方，你点「执行」才改。现在只能改地形，历史等创建以后再改。',
};

/** 没发出去的话(面板关了再打开还在) */
let draft = '';

export interface AssistantPanelProps {
  phone: boolean;
  world: World;
  raster: Raster | null;
  /** 套上改名的这份历史(界面上的名字;在地图上看试推演时也是现在这份,不是试推演的) */
  civ: Civ;
  raw: Civ;
  lock?: RewriteLock;
  /** 正在重推 / 按新地形重新生成 / 生成新世界 */
  busy: boolean;
}

export function AssistantPanel({ phone, world, raster, civ, raw, lock, busy }: AssistantPanelProps) {
  const st = useAssistant();
  const ai = useAiStatus();
  useEdits();
  useSavesVersion();
  const [text, setText] = useState(draft);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  // 换了世界、世界刚建好(阶段变了):对话换成那个世界的
  useEffect(() => syncAssistantWorld(lock), [world, civ, lock]);
  useEffect(() => {
    draft = text;
  }, [text]);
  useEffect(() => {
    if (!phone) input.current?.focus({ preventScroll: true });
  }, [phone]);

  // 新的一轮、多了一步、结果回来:滚到底
  const last = st.turns[st.turns.length - 1];
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [st.turns.length, last?.status, last?.steps.length, last?.names, !!last?.text]);

  const working = last?.status === 'working';
  // 没设置 AI 也能发:这一轮报"还没有设置 AI"、旁边一个"设置 AI"(按了回车总有回应)
  const can = !!text.trim() && !working && !(ai.ready && busy);
  const send = () => {
    if (!can) return;
    const w = text.trim();
    setText('');
    void sendAsk({ world, raster, civ, raw, year: getCivTime().year ?? civ.endYear, lock }, w);
  };
  const examples = useMemo(() => exampleAsks(civ, lock), [civ, lock]);
  const links = useMemo(() => linkDict(civ), [civ]);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const model = ai.ready ? (ai.model && ai.model !== 'mock' ? `${ai.label} ${ai.model}` : ai.label) : '还没设置 AI';

  // 手机:往下拉收起(对话留着)
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const dragProps = phone
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if ((e.target as Element).closest('button')) return;
          dragFrom.current = e.clientY;
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        },
        onPointerMove: (e: React.PointerEvent) => {
          if (dragFrom.current !== null) setDrag(Math.max(0, e.clientY - dragFrom.current));
        },
        onPointerUp: () => {
          if (dragFrom.current === null) return;
          dragFrom.current = null;
          if (drag > 90) closeAssistant();
          setDrag(0);
        },
        onPointerCancel: () => {
          dragFrom.current = null;
          setDrag(0);
        },
      }
    : {};

  return (
    <aside
      className={`ast-panel${phone ? ' phone' : ''}${drag ? ' dragging' : ''}`}
      aria-label="助手"
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onWheel={stop}
    >
      <div className="ast-top" {...dragProps}>
        {phone && (
          <button className="ast-grip" data-act="ast-grip" aria-label="收起" onClick={closeAssistant}>
            <i aria-hidden="true" />
          </button>
        )}
        <header className="ast-head">
          <div className="ast-title">
            <b>助手</b>
            <small>{model}</small>
          </div>
          <button className="ast-pill" data-act="ast-new" title="新对话" aria-label="新对话" disabled={!st.turns.length} onClick={newConversation}>
            <Icon name="compose" size={16} />
          </button>
          <button className="ast-pill" data-act="ast-close" title="收起" aria-label="收起" onClick={closeAssistant}>
            <Icon name="close" size={15} />
          </button>
        </header>
      </div>
      <div className="ast-log" ref={log}>
        {!st.turns.length && (
          <>
            <div className="ast-hint">{HINT[lock ?? 'none']}</div>
            {!ai.ready && (
              <div className="ast-unset">
                <span>{ai.reason ?? '还没设置 AI'}</span>
                <button className="ast-link" onClick={() => openAiSettings()}>
                  设置 AI
                </button>
              </div>
            )}
            {!!examples.length && (
              <>
                <div className="ast-sec">
                  <span>试试这样说</span>
                </div>
                <div className="ast-grp">
                  {examples.map((x) => (
                    <button key={x} className="ast-row link ast-example" onClick={() => (setText(x), input.current?.focus())}>
                      <span className="tx">
                        <b>{x}</b>
                      </span>
                      <span className="end">
                        <Icon name="chevron" size={14} />
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {st.turns.map((t) => (
          <Turn key={t.id} t={t} latest={t === last} phone={phone} busy={busy} civ={civ} links={links} previewing={st.preview?.turn === t.id} />
        ))}
      </div>
      <div className="ast-input">
        {ai.ready && busy && <div className="ast-unset">世界正在重推，好了再说</div>}
        {!ai.ready && !!st.turns.length && (
          <div className="ast-unset">
            <span>{ai.reason ?? '还没设置 AI'}</span>
            <button className="ast-link" onClick={() => openAiSettings()}>
              设置 AI
            </button>
          </div>
        )}
        <div className="ast-field">
          <textarea
            ref={input}
            value={text}
            rows={phone ? 1 : 2}
            maxLength={WISH_MAX}
            placeholder={placeholder(last, working, phone, lock)}
            spellCheck={false}
            aria-label="对助手说"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {working ? (
            <button className="ast-send stop" data-act="ast-stop" title="停下" aria-label="停下" onClick={stopAsk}>
              <i aria-hidden="true" />
            </button>
          ) : (
            <button className={`ast-send${can ? '' : ' off'}`} data-act="ast-send" title="发送" aria-label="发送" disabled={!can} onClick={send}>
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** 输入框里的灰字:空的时候 / 助手在做 / 接着说(按上一轮是改世界、起名还是问答;手机上不带例子) */
function placeholder(last: AsTurn | undefined, working: boolean, phone: boolean, lock?: RewriteLock): string {
  if (working) return '助手在做，可以随时停下';
  if (!last) return lock === 'history' ? '说说想把这颗星球改成什么样' : '说说想怎么改这个世界，或者问点什么';
  if (lock === 'history' && last.proposal) return '接着说，比如“湖再小一点”';
  if (phone && (last.proposal || last.names)) return '接着说';
  if (last.proposal) return '接着说，比如“再让它多几个州”';
  if (last.names) return '接着说，比如“再古朴一点”';
  if (last.steps.some((s) => s.tool === 'write_book')) return '接着说';
  return last.status === 'done' ? '接着问' : '接着说';
}

// ---------------------------------------------------------------------------
// 一轮

interface TurnProps {
  t: AsTurn;
  latest: boolean;
  phone: boolean;
  busy: boolean;
  civ: Civ;
  links: LinkDict;
  previewing: boolean;
}

function Turn({ t, latest, phone, busy, civ, links, previewing }: TurnProps) {
  const done = t.status === 'done';
  return (
    <div className="ast-turn" data-turn={t.id}>
      <div className="ast-me">{t.ask}</div>
      {t.reasoning?.map(r => <details className="ast-reasoning" key={r.round} open={t.status === 'working'}>
        <summary>思考过程 · 第 {r.round + 1} 轮</summary>
        <pre>{r.text}</pre>
      </details>)}
      <Steps t={t} />
      {/* 问答的回话里国名、城名是蓝字;交确认单的那一轮下面有结果对比,不再标 */}
      {!!t.text && <Say text={t.text} links={done && !t.proposal ? links : null} phone={phone} />}
      {t.proposal?.cannot.map((c, i) => (
        <div key={i} className="ast-cant">
          <b>做不到</b>
          {c}
        </div>
      ))}
      {t.names && <Names t={t} />}
      {done && t.proposal && <Proposal t={t} latest={latest} phone={phone} busy={busy} previewing={previewing} />}
      {done && !t.proposal && !t.names && <Events text={t.text} civ={civ} links={links} />}
    </div>
  );
}

/** 每一步:做的时候一步一行;做完收成一行(只有一步、写史书的那一步照样单列),点开看全部 */
function Steps({ t }: { t: AsTurn }) {
  const [open, setOpen] = useState(false);
  const steps = t.steps;
  const err = t.status === 'error' && t.error;
  if (!steps.length && !err) return null;
  const book = steps.filter((s) => s.book);
  const rest = steps.filter((s) => !s.book);
  const fold = t.status === 'done' && rest.length >= 2 && !open;
  return (
    <div className="ast-grp ast-steps">
      {fold ? (
        <button className="ast-row link" data-act="ast-steps" onClick={() => setOpen(true)}>
          <StepIcon state="ok" />
          <span className="tx">
            <b>{stepsSummary(rest)}</b>
          </span>
          <span className="end">
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : (
        rest.map((s) => <StepRow key={s.id} s={s} />)
      )}
      {book.map((s) => (
        <BookRow key={s.id} s={s} />
      ))}
      {err && (
        <div className="ast-row ast-error">
          <StepIcon state="error" />
          <span className="tx">
            <b>{err.message}</b>
          </span>
          {err.code === 'not-configured' && (
            <button className="ast-link end" onClick={() => openAiSettings()}>
              设置 AI
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StepIcon({ state }: { state: AsStep['state'] }) {
  if (state === 'run') return <span className="ast-st run" aria-label="正在做" />;
  return <span className={`ast-st ${state === 'ok' ? 'ok' : 'no'}`}>{state === 'ok' ? <Icon name="check" size={15} /> : <Icon name="close" size={13} />}</span>;
}

function StepRow({ s }: { s: AsStep }) {
  return (
    <div className="ast-row" data-tool={s.tool}>
      <StepIcon state={s.state} />
      <span className="tx">
        <b>{s.label}</b>
        {(s.summary || s.state === 'run') && <small>{s.summary ?? (s.tool === 'try_edits' ? '正在推演' : '正在做')}</small>}
      </span>
    </div>
  );
}

/** 写史书:写的时候转圈 + 进度条,写好打勾;"打开"读它 */
function BookRow({ s }: { s: AsStep }) {
  const { job } = useBook();
  const b = s.book!;
  const j = job && job.id === b.id ? job : null;
  const writing = j?.status === 'writing';
  const failed = j?.status === 'error' || j?.status === 'stopped';
  const pct = j ? Math.round(bookProgress(j) * 100) : 100;
  const how = s.summary ?? '';
  const now = writing ? `正在写第 ${Math.min(j!.calls, j!.call + 1)} ${bookUnit(j!.opts.style)}` : failed ? '没写完' : '写好了，在「成书」里';
  return (
    <div className="ast-row" data-tool="write_book">
      <StepIcon state={writing ? 'run' : failed ? 'error' : 'ok'} />
      <span className="tx">
        <b>写史书：《{b.title}》</b>
        <small>{how ? `${how}；${now}` : now}</small>
        {writing && (
          <span className="ast-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {!failed && (
        <button className="ast-link end" data-act="ast-book-open" onClick={() => openBookReader(writing ? null : b.key)}>
          打开
        </button>
      )}
    </div>
  );
}

/** 确认单上一条、列出的大事换成全角标点,和助手说的话一样("特拉维亚共和国:保护(至第 2300 年)" → "特拉维亚共和国：保护（至第 2300 年）") */
const wide = (t: string) =>
  t
    .replace(/:/g, '：')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/,/g, '，')
    .replace(/;/g, '；');

/** 助手说的话:一段一行;给了 links = 说到的国家、城是蓝字,点了在地图上打开(手机先收起面板;已经打开着的那个不标) */
function Say({ text, links, phone }: { text: string; links: LinkDict | null; phone: boolean }) {
  const cur = useSelection().sel;
  const open = (sel: MapSelection) => {
    setSelection(sel);
    requestFly('sel');
    if (phone) closeAssistant();
  };
  return (
    <>
      {text
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p, i) => (
          <p key={i} className="ast-say">
            {links ? linkify(p, links, open, cur) : p}
          </p>
        ))}
    </>
  );
}

/** 起名的候选:名字(西文写法)+ 含义 +「就用这个」 */
function Names({ t }: { t: AsTurn }) {
  const n = t.names!;
  // "正在用"看现在的名字(⌘Z 撤销了改名,又是"就用这个")
  const { names } = useEdits();
  return (
    <div className="ast-grp ast-names">
      {n.list.map((c, i) => (
        <div key={c.name} className="ast-row cand">
          <span className="tx">
            <b>
              {c.name}
              {c.latin && <em>{c.latin}</em>}
            </b>
            {c.meaning && <small>{c.meaning}</small>}
          </span>
          {(names[c.key] ?? null) === c.value ? (
            <span className="end">正在用</span>
          ) : (
            <button className="ast-link end" data-act="ast-use-name" onClick={() => pickName(t.id, i)}>
              就用这个
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 确认单

function itemYear(x: { year?: number; op: string }): string {
  if (x.year !== undefined) return String(x.year);
  return TERRAIN_OPS.includes(x.op) ? '地形' : x.op === 'rename' ? '改名' : '—';
}

function Proposal({ t, latest, phone, busy, previewing }: { t: AsTurn; latest: boolean; phone: boolean; busy: boolean; previewing: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const st = useAssistant();
  useEdits();
  const p = t.proposal!;
  const off = new Set(t.off ?? []);
  const n = pickedChanges(t).length;
  const okCount = p.items.filter((x) => x.change).length;
  const frozen = !!t.applied || !!t.dismissed;
  const block = frozen ? '' : applyBlock(t, { busy });
  const pblock = frozen ? '' : previewBlock(t, { busy });
  const terrain = p.items.some((x, i) => x.change?.kind === 'terrain' && !off.has(i));
  const mixed = terrain && p.items.some((x, i) => x.change?.kind === 'intervention' && !off.has(i));
  const loading = previewing && !st.preview?.raw;
  /** 新建世界时:编号对上星球上的圈;执行后是一行"已执行 N 条",手机上也有"不要" */
  const numbered = t.lock === 'history';
  const apply = () => {
    const why = applyProposal(t.id, { busy });
    setMsg(why);
  };
  const preview = () => {
    const why = previewProposal(t.id, { busy });
    setMsg(why);
    // 手机:先收起面板看地图(对话留着,地图上方的提示能执行或回到现在)
    if (!why && phone && !previewing) closeAssistant();
  };
  return (
    <>
      {/* 新建时执行了就只留"已执行 N 条"那一行,清单收起来 */}
      {!!p.items.length && !(numbered && t.applied) && (
        <>
          {!phone && (
            <div className="ast-sec">
              <span>要改的 {p.items.length} 条</span>
            </div>
          )}
          <div className="ast-grp ast-items">
            {p.items.map((x, i) => {
              const ok = !!x.change;
              const on = ok && !off.has(i);
              return (
                <div key={i} className={`ast-row item${ok ? '' : ' bad'}${on ? '' : ' off'}`}>
                  <button
                    className={`ast-ck${on ? '' : ' off'}`}
                    role="checkbox"
                    aria-checked={on}
                    disabled={!ok || frozen}
                    onClick={() => toggleItem(t.id, i)}
                    title={ok ? (on ? '不要这一条' : '要这一条') : '这一条不能执行'}
                  >
                    {on && <Icon name="check" size={12} />}
                  </button>
                  {/* 新建时改地形的几条:编号和星球上圈出来的对上 */}
                  {numbered && x.change?.kind === 'terrain' ? <span className="ast-no">{i + 1}</span> : <span className="yr">{itemYear(x)}</span>}
                  <span className="tx">
                    <b>{wide(x.text)}</b>
                    {(x.problem || x.why) && <small>{x.problem ? `不能执行：${x.problem}` : x.why}</small>}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {terrain && !frozen && t.lock !== 'history' && (
        <div className="ast-note">
          {mixed
            ? '同时有改地形和历史命令：地形一改，三千年历史整个重来，这些命令多半对不上。建议先只执行改地形，再接着说历史那部分'
            : '含改地形：整个世界会按新地形重新生成，三千年历史整个重来（命令和改名尽量保留）'}
        </div>
      )}
      {p.trial && <TrialResult v={p.trial} phone={phone} partial={off.size > 0 ? [n, okCount] : null} more={more} onMore={() => setMore((m) => !m)} />}
      {t.applied && numbered ? (
        <div className="ast-grp">
          <div className="ast-row ast-applied">
            <StepIcon state={t.applied.undone ? 'error' : 'ok'} />
            <span className="tx">
              <b>{t.applied.undone ? '已撤销' : `已执行 ${n} 条`}</b>
              {!t.applied.undone && t.lock === st.lock && <small>记在左边「地形」里</small>}
            </span>
            {!t.applied.undone && t.lock === st.lock && (
              <button className="ast-link end" data-act="ast-undo" onClick={() => undoProposal(t.id)}>
                撤销
              </button>
            )}
          </div>
        </div>
      ) : t.applied ? (
        <div className="ast-acts">
          <span className="ast-done">{t.applied.undone ? '已撤销' : '已执行'}</span>
          {!t.applied.undone && t.lock === st.lock && (
            <button className="ast-link" data-act="ast-undo" onClick={() => undoProposal(t.id)}>
              撤销
            </button>
          )}
        </div>
      ) : t.dismissed ? (
        <div className="ast-under">没有执行</div>
      ) : (
        okCount > 0 && (
          <>
            <div className="ast-acts">
              <button className="ast-btn primary" data-act="ast-apply" disabled={block !== null} onClick={apply}>
                执行{n ? ` ${n} 条` : ''}
              </button>
              {previewable(t) && (
                <button className={`ast-btn${previewing ? ' on' : ''}`} data-act="ast-preview" disabled={!previewing && pblock !== null} onClick={preview}>
                  {!phone && <Icon name="map" size={15} />}
                  {previewing ? (loading ? '正在推演' : '正在地图上看') : phone ? '在地图上看看' : '先在地图上看看'}
                </button>
              )}
              {(!phone || numbered) && (
                <button className="ast-btn text" data-act="ast-dismiss" onClick={() => dismissProposal(t.id)}>
                  不要
                </button>
              )}
            </div>
            {(msg || (block && latest)) && <div className="ast-under">{msg || block}</div>}
          </>
        )
      )}
    </>
  );
}

/** 一行结果:国名(小字)+ 现在 → 试推演 */
function ResultRow({ r }: { r: TrialRow }) {
  return (
    <div className="ast-row">
      <span className="tx">
        <b>{r.name}</b>
        {r.note && <small>{r.note}</small>}
      </span>
      <span className="end">
        {r.was && (
          <>
            <span className="was">{r.was}</span>
            <span className="arrow">→</span>
          </>
        )}
        {r.now}
      </span>
    </div>
  );
}

function TrialResult({ v, phone, partial, more, onMore }: { v: TrialView; phone: boolean; partial: [number, number] | null; more: boolean; onMore: () => void }) {
  const ev = v.addedCount || v.removedCount ? `少了 ${v.removedCount} 件，多了 ${v.addedCount} 件` : '没有变化';
  const evRow = (
    <div className="ast-row">
      <span className="tx">
        <b>第 {v.from} 年以后的大事</b>
      </span>
      <span className="end">{ev}</span>
    </div>
  );
  const list = more && (v.addedCount > 0 || v.removedCount > 0) && <EventDiff v={v} />;
  const under = partial && <div className="ast-under">勾掉了 {partial[1] - partial[0]} 条，上面是全部 {partial[1]} 条一起试推演的结果</div>;
  if (phone) {
    // 手机:只留关注的国家一行 +「别的国家和大事」(点开看其余)
    const head = v.rows.slice(0, Math.max(1, v.focus));
    const tail = [...v.rows.slice(head.length), ...v.rest];
    return (
      <>
        <div className="ast-grp ast-result">
          {head.map((r) => (
            <ResultRow key={r.name} r={r} />
          ))}
          <button className="ast-row link" data-act="ast-more" aria-expanded={more} onClick={onMore}>
            <span className="tx">
              <b>别的国家和大事</b>
              <small>{v.others}</small>
            </span>
            <span className={`end${more ? ' open' : ''}`}>
              <Icon name="chevron" size={14} />
            </span>
          </button>
          {more && tail.map((r) => <ResultRow key={r.name} r={r} />)}
          {more && evRow}
        </div>
        {list}
        {under}
      </>
    );
  }
  return (
    <>
      <div className="ast-sec">
        <span>试推演的结果</span>
        {(v.addedCount > 0 || v.removedCount > 0) && (
          <button className="ast-link" data-act="ast-events" aria-expanded={more} onClick={onMore}>
            {more ? '收起大事' : '变了哪些大事'}
          </button>
        )}
      </div>
      <div className="ast-grp ast-result">
        {v.rows.map((r) => (
          <ResultRow key={r.name} r={r} />
        ))}
        {evRow}
      </div>
      {list}
      {under}
    </>
  );
}

/** 变了哪些大事:试推演里多出来的、不再发生的 */
function EventDiff({ v }: { v: TrialView }) {
  const part = (title: string, list: TrialView['added'], count: number) =>
    count > 0 && (
      <>
        <div className="ast-sec">
          <span>
            {title}
            {count > list.length ? `（共 ${count} 件，列前 ${list.length} 件）` : ''}
          </span>
        </div>
        <div className="ast-grp">
          {list.map((e, i) => (
            <div key={i} className="ast-row">
              <span className="yr">{e.year}</span>
              <span className="tx">
                <b>{wide(e.text)}</b>
              </span>
            </div>
          ))}
        </div>
      </>
    );
  return (
    <>
      {part('试推演里多出来的', v.added, v.addedCount)}
      {part('不再发生的', v.removed, v.removedCount)}
    </>
  );
}

// ---------------------------------------------------------------------------
// 说到的大事、蓝字

type LinkDict = { re: RegExp | null; map: Map<string, MapSelection> };

/** 能点的名字:国家的各个国号(两个字以上)、城名;长的先认 */
function linkDict(civ: Civ): LinkDict {
  const map = new Map<string, MapSelection>();
  for (const p of civ.polities) for (const n of polityAllTitles(p)) if ([...n].length >= 2 && !map.has(n)) map.set(n, { kind: 'polity', id: p.id });
  for (const s of civ.settlements) if ([...s.name].length >= 2 && !map.has(s.name)) map.set(s.name, { kind: 'settlement', id: s.id });
  const names = [...map.keys()].sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { re: names.length ? new RegExp(`(${names.map(esc).join('|')})`, 'g') : null, map };
}

function linkify(text: string, d: LinkDict, open: (sel: MapSelection) => void, skip?: MapSelection | null): ReactNode[] {
  if (!d.re) return [text];
  return text.split(d.re).map((part, i) => {
    const sel = i % 2 === 1 ? d.map.get(part) : undefined;
    return sel && !(skip && skip.kind === sel.kind && skip.id === sel.id) ? (
      <button key={i} className="ast-name" data-act="ast-name" onClick={() => open(sel)}>
        {part}
      </button>
    ) : (
      part
    );
  });
}

/** 问答下面:话里说到的年份对上编年史(同一年有几条,挑说到的国家参与的、重要的);最多 5 条,点了时间轴跳过去 */
function Events({ text, civ, links }: { text: string; civ: Civ; links: LinkDict }) {
  const list = useMemo(() => mentionedEvents(text, civ, links), [text, civ, links]);
  if (!list.length) return null;
  return (
    <>
      <div className="ast-sec">
        <span>说到的大事</span>
      </div>
      <div className="ast-grp ast-events">
        {list.map((e, i) => (
          <button key={i} className="ast-row link" data-act="ast-event" onClick={() => pickChronicleEntry(e)}>
            <span className="yr">{Math.floor(e.year)}</span>
            <span className="tx">
              <b>{wide(e.text)}</b>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function mentionedEvents(text: string, civ: Civ, links: LinkDict): ChronicleEntry[] {
  if (!civ.viable) return [];
  const years = [...new Set([...text.matchAll(/(\d{3,4})\s*年/g)].map((m) => Number(m[1])))].filter((y) => y <= civ.endYear);
  if (!years.length) return [];
  const who = new Set<number>();
  if (links.re) for (const m of text.matchAll(links.re)) {
    const s = links.map.get(m[1]);
    if (s?.kind === 'polity') who.add(s.id);
  }
  const all = buildChronicle(civ).filter((e) => e.importance >= 2 && e.kind !== 'intervene');
  const out: ChronicleEntry[] = [];
  for (const y of years) {
    const hits = all.filter((e) => Math.floor(e.year) === y);
    if (!hits.length) continue;
    hits.sort((a, b) => Number(b.polities.some((p) => who.has(p))) - Number(a.polities.some((p) => who.has(p))) || b.importance - a.importance);
    if (!out.includes(hits[0])) out.push(hits[0]);
    if (out.length >= 5) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 例子

/** 空的时候的五句例子(用这个世界里的名字):撑下去、为什么、写国史、起名、某一年的天下 */
export function exampleAsks(civ: Civ, lock?: RewriteLock): string[] {
  const range = civ.places.find((p) => p.kind === 'mountains');
  // 还在新建:改地形的例子 + 一句提问(助手这时不改世界参数)
  if (lock === 'history')
    return ['在最大的那块陆地中间挖个大湖，湖北边再加一道山脉', '赤道附近的大洋里放一串火山岛', range ? `把${range.name}再拉长一些` : '最西边那块大陆的海岸加一道山脉', '这颗星球最高的山在哪？'];
  if (!civ.viable || !civ.polities.length) return [];
  const end = Math.floor(civ.endYear);
  const P = civ.polities;
  const own = civ.polity;
  const size = new Map<number, number>();
  for (const o of own) if (o >= 0) size.set(o, (size.get(o) ?? 0) + 1);
  const alive = P.filter((p) => polityAlive(p, end) && (size.get(p.id) ?? 0) > 0).sort((a, b) => (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0) || a.id - b.id);
  const name = (p: (typeof P)[number], y = end) => polityName(p, y) || p.name;
  const out: string[] = [];
  // 最近被灭的、撑过百年的国家:撑到最后一年
  const conquered = new Set(civ.annals.filter((e) => e.kind === 'fall').map((e) => e.a));
  const fallen = P.filter((p) => p.ended !== undefined && p.ended - p.founded >= 100 && p.ended < end && conquered.has(p.id)).sort((a, b) => b.ended! - a.ended! || a.id - b.id)[0];
  if (fallen) out.push(`让${name(fallen, Math.floor(fallen.ended!) - 1)}撑到第 ${end} 年`);
  if (alive[0]) out.push(`${name(alive[0])}为什么能变成最大的国家？`);
  const book = alive[Math.min(4, alive.length - 1)];
  if (book) out.push(`给${name(book)}写一部一万字的国史`);
  const city = alive[Math.min(2, alive.length - 1)];
  if (city) {
    const c = civ.settlements[capitalAt(city, end)];
    if (c) out.push(`${name(city)}的国都${c.name}换个更有气势的名字`);
  }
  out.push(`第 ${Math.max(100, Math.round((end * 2) / 300) * 100)} 年的天下是什么样？`);
  return out.slice(0, 5);
}

/** 地图上方的提示条(在地图上看试推演时):还没执行 · 执行 N 条 · 回到现在 */
export function PreviewBanner({ busy, phone }: { busy: boolean; phone: boolean }) {
  const st = useAssistant();
  useEdits();
  const p = st.preview;
  const t = p ? st.turns.find((x) => x.id === p.turn) : undefined;
  if (!p || !t) return null;
  const n = pickedChanges(t).length;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className={`ast-banner${phone ? ' phone' : ''}`} role="status" onPointerDown={stop} onClick={stop} onDoubleClick={stop}>
      <span className="ast-banner-text">{p.raw ? '地图上是试推演的结果，还没执行' : '正在试推演……'}</span>
      <span className="ast-banner-acts">
        <button className="ast-btn primary" data-act="ast-banner-apply" disabled={!p.raw || applyBlock(t, { busy }) !== null} onClick={() => applyProposal(t.id, { busy })}>
          执行 {n} 条
        </button>
        <button className="ast-btn" data-act="ast-banner-back" onClick={exitPreview}>
          回到现在
        </button>
      </span>
    </div>
  );
}
