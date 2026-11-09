import { readdirSync, readFileSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const STATE_DIR = join(
  homedir(),
  'Library/Application Support/Ulanzi/UlanziDeck/claude-state'
);

const WORKING_STALE_MS = 15 * 60 * 1000; // working with no events this long = dead session
const DEAD_MS = 12 * 60 * 60 * 1000;     // any file this old is ignored entirely

const PRIORITY = { asking: 4, attention: 3, compacting: 2, working: 1, waiting: 0 };

// tools whose pending prompt the deck can answer (mirrors ASKING_TOOLS in the hook)
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const TRANSCRIPT_TAIL = 131072;

// sid -> { size, mtimeMs, ts, resolved } so the 1 s polls of every key don't
// re-read the transcript unless it actually grew
const RESOLVED_CACHE = new Map();

// Has the question behind an `asking` state already been dealt with?
//
// Esc-cancelling a question fires NO hook, so the state file keeps saying
// `asking` until the next session event or the 15-min stale rule. During that
// window a deck OK would type a digit into the prompt box — and on
// Terminal.app, whose `do script` always appends a newline, *submit* it as a
// prompt. The transcript does record the outcome: every answered, rejected or
// cancelled tool call gets a tool_result. So the ask is over once a tool_result
// for an asking tool appears with a timestamp after the hook wrote the state
// (older asks in the tail are resolved before s.ts and never match).
// Unknown (old state file without a transcript path, unreadable transcript) →
// false, i.e. the previous behaviour.
export function askResolved(s) {
  const tp = s && s.transcript;
  if (!tp || typeof s.ts !== 'number') return false;
  let fd;
  try {
    fd = openSync(tp, 'r');
    const st = fstatSync(fd);
    const hit = RESOLVED_CACHE.get(s.sid);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ts === s.ts) return hit.resolved;
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    const askIds = new Set();
    let resolved = false;
    const askedAt = s.ts * 1000;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue; // partial first line of the tail window
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_use' && ASKING_TOOLS.has(b.name)) askIds.add(b.id);
        else if (b.type === 'tool_result' && askIds.has(b.tool_use_id)) {
          if (s.tool_use_id && b.tool_use_id !== s.tool_use_id) continue;
          const at = Date.parse(rec.timestamp || '');
          if (at > askedAt) resolved = true;
        }
      }
    }
    RESOLVED_CACHE.set(s.sid, { size: st.size, mtimeMs: st.mtimeMs, ts: s.ts, resolved });
    return resolved;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

export function readStates() {
  let files;
  try {
    // skip dotfiles: the dir also holds helper files like .bigkey-widget.json
    files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const now = Date.now();
  const states = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
      if (!(s.state in PRIORITY) || typeof s.ts !== 'number') continue; // not a session state file
      s.sid = f.slice(0, -5);
      const age = now - s.ts * 1000;
      if (age > DEAD_MS) continue;
      if ((s.state === 'working' || s.state === 'compacting' || s.state === 'asking') && age > WORKING_STALE_MS) {
        s.state = 'waiting';
      } else if (s.state === 'asking' && askResolved(s)) {
        // answered/cancelled in the terminal without a hook firing (Esc)
        s.state = 'waiting';
        delete s.ask;
      }
      states.push(s);
    } catch { /* partial write or bad file — skip */ }
  }
  return states;
}

// Overall pet state. Optional dir filter narrows to sessions in that project.
export function aggregateState(states, dir) {
  let list = states;
  if (dir) list = states.filter(s => s.cwd === dir || s.cwd.startsWith(dir + '/'));
  if (!list.length) return { state: 'none', count: 0 };
  let best = list[0];
  for (const s of list) {
    if (PRIORITY[s.state] > PRIORITY[best.state]) best = s;
  }
  return { ...best, count: list.length };
}

// The session currently asking a question with a captured option list.
// A pinned session's question wins when several ask at once (so the switch
// key chooses which one to answer first); otherwise the newest ask shows.
export function askingSession(states, preferSid) {
  const asking = states.filter(s => s.state === 'asking' && s.ask && s.ask.options?.length);
  if (!asking.length) return null;
  if (preferSid) {
    const pinned = asking.find(s => s.sid === preferSid);
    if (pinned) return pinned;
  }
  return asking.reduce((a, b) => (b.ts > a.ts ? b : a));
}

// Best-effort match of an iTerm session (by its title) to a Claude session:
// Claude Code titles usually contain the project directory name.
export function stateForSessionName(states, name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  const matches = states.filter(s => {
    const base = basename(s.cwd || '').toLowerCase();
    return base && lower.includes(base);
  });
  if (matches.length) {
    let best = matches[0];
    for (const s of matches) {
      if (PRIORITY[s.state] > PRIORITY[best.state]) best = s;
    }
    return best;
  }
  if (states.length === 1) return states[0]; // only one live claude — assume it's this one
  return null;
}
