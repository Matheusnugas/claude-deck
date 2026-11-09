#!/usr/bin/env node
/* Write the Claude Session Screen action (UUID `itermcycle`) into the big key
 * (slot 3_2) of the current page of every active profile — or restore the
 * built-in widget there, per the `.bigkey-desired` flag. Must run while Ulanzi
 * Studio is NOT running (Studio rewrites profile files from memory on quit).
 *
 * Node port of patch-bigkey.py, same behaviour and output. It exists because
 * a clean consumer Mac has no usable python3 (/usr/bin/python3 is a stub that
 * opens the Xcode Command Line Tools installer); bigkey-toggle.sh and
 * bigkey-watcher.sh run this on the Node that Ulanzi Studio ships (passed in
 * as CLAUDEDECK_NODE by the plugin) and only fall back to the python version.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const BASE = path.join(os.homedir(), 'Library/Application Support/Ulanzi/UlanziDeck');
const ACTION_UUID = 'com.claudedeck.deck.plugin.itermcycle';
const WIDGET_ACTION = 'com.ulanzi.ulanzideck.smallwindow.window';
const WIDGET_SAVE = path.join(BASE, 'claude-state/.bigkey-widget.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeEntry(smallViewMode) {
  const entry = {
    Action: ACTION_UUID,
    ActionID: randomUUID(),
    ActionParam: { mode: 'windows', SmallViewMode: 2 },
    LinkedTitle: true,
    Name: 'Cycle iTerm Sessions',
    Plugin: { Name: 'Claude Deck', UUID: 'com.claudedeck.deck.plugin', Version: '1.0.0' },
    State: 0,
    ViewParam: [{
      Icon: path.join(BASE, 'Plugins/com.claudedeck.deck.plugin.ulanziPlugin/resources/action-itermcycle.png'),
      IconRel: '',
    }],
  };
  if (smallViewMode !== undefined && smallViewMode !== null) {
    entry.ActionParam.SmallViewMode = smallViewMode;
  }
  return entry;
}

// The widget to restore on hide: the exact entry that was replaced on the last
// show, else a default visible mode 0 — 'Background with no image' renders
// nothing and the deck keeps showing the stale claude frame, which looks like
// the hide failed.
function widgetEntry() {
  try {
    const saved = readJson(WIDGET_SAVE);
    if (saved && saved.Action === WIDGET_ACTION) {
      saved.ActionID = randomUUID();
      return saved;
    }
  } catch { /* no saved widget — default below */ }
  return {
    Action: WIDGET_ACTION,
    ActionID: randomUUID(),
    ActionParam: { SmallViewMode: 0 },
    LinkedTitle: true,
    Name: '',
    Plugin: {},
    State: 0,
    ViewParam: [{ Icon: '', IconRel: '' }],
  };
}

function saveWidget(entry) {
  if (entry && entry.Action === WIDGET_ACTION) {
    try {
      fs.writeFileSync(WIDGET_SAVE, JSON.stringify(entry));
    } catch { /* best effort */ }
  }
}

function desiredOn() {
  try {
    return fs.readFileSync(path.join(BASE, 'claude-state/.bigkey-desired'), 'utf8').trim() !== 'off';
  } catch {
    return true;
  }
}

// keep the page as it was before Claude Deck first touched it
function backupOnce(file) {
  const bak = file + '.bak-bigkey';
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function main() {
  const wantOn = desiredOn();
  const setting = readJson(path.join(BASE, 'Config/setting_source.json'));
  const root = path.join(BASE, 'ProfilesV2');
  let patched = 0;
  for (const dev of setting.Devices || []) {
    const profName = dev.CurrentProfile;
    const devUuid = dev.CurrentDevice;
    for (const group of fs.readdirSync(root)) {
      const gmPath = path.join(root, group, 'manifest.json');
      if (!fs.existsSync(gmPath) || !fs.statSync(gmPath).isFile()) continue;
      const gm = readJson(gmPath);
      if (gm.Name !== profName || (gm.Device || {}).UUID !== devUuid) continue;
      const page = (gm.Pages || {}).Current;
      const pmPath = path.join(root, group, 'Profiles', page || '', 'manifest.json');
      if (!page || !fs.existsSync(pmPath)) continue;
      const pm = readJson(pmPath);
      for (const c of pm.Controllers || []) {
        if (c.Type !== 'Keypad') continue;
        const cur = (c.Actions || {})['3_2'] || {};
        const isOurs = cur.Action === ACTION_UUID;
        if (wantOn === isOurs) continue; // already in the desired state
        const svm = (cur.ActionParam || {}).SmallViewMode;
        backupOnce(pmPath);
        if (wantOn) saveWidget(cur);
        c.Actions = c.Actions || {};
        c.Actions['3_2'] = wantOn ? makeEntry(svm) : widgetEntry();
        fs.writeFileSync(pmPath, JSON.stringify(pm, null, 1));
        console.log(`${profName} / ${page}: ${wantOn ? 'patched' : 'restored widget'}`);
        patched += 1;
      }
    }
  }
  console.log(`done (${wantOn ? 'show' : 'hide'}), ${patched} page(s) changed`);
}

main();
