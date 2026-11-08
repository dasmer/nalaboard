import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const source = readFileSync(
  new URL("../bigscreen.js", import.meta.url),
  "utf8",
).replace(/^import .*\n/gm, "");
const handlers = {},
  stack = [{}];
let position = 0,
  now = 1000;
const countdown = { textContent: "" },
  node = {
    addEventListener() {},
    querySelector: () => countdown,
    replaceChildren() {},
  };
const history = {
  get state() {
    return stack[position];
  },
  replaceState(s) {
    stack[position] = s;
  },
  pushState(s) {
    stack.splice(position + 1);
    stack.push(s);
    position++;
  },
  go(delta) {
    position += delta;
    assert.ok(position >= 0 && position < stack.length);
    handlers.popstate({ state: stack[position] });
  },
};
const context = createContext({
  console,
  Date: class extends Date {
    static now() {
      return now;
    }
  },
  history,
  location: { pathname: "/bigscreen" },
  document: { querySelector: () => node, addEventListener() {} },
  window: {
    addEventListener: (name, fn) => {
      handlers[name] = fn;
    },
  },
  setTimeout: () => 1,
  clearTimeout() {},
  setInterval: () => 2,
  clearInterval() {},
});
const run = (code) => runInContext(code, context);
run(source.slice(0, source.lastIndexOf("\npoll();")));
run(
  'render=()=>{};resetIdle=()=>{};playNext=()=>{};snapshot={};go("board");draft={flow:"entry",games:[],states:[],index:0};go("me");go("opponent");loadGame(0);',
);
assert.equal(history.state.nbDisplay.depth, 3);
run(
  'draft.current={winner:0,points:7,type:"exact"};draft.states[0]={...draft.current};',
);
history.go(-1);
assert.equal(run("scene"), "opponent");
history.go(1);
assert.equal(run("scene"), "score");
assert.equal(
  run("draft.current.points"),
  7,
  "Browser Forward restores the current score",
);
run('draft=null;go("board");');
assert.equal(position, 0, "Logo/exit collapses entry history to the board");
assert.equal(run("scene"), "board");
history.go(1);
assert.equal(
  run("scene"),
  "board",
  "Completed drafts cannot be reopened with Forward",
);
run(
  'celebration={endsAt:Date.now()+30000};scene="celebrate";updateCountdown();',
);
assert.equal(countdown.textContent, "Back to board in 30s");
now += 1000;
run("updateCountdown();");
assert.equal(countdown.textContent, "Back to board in 29s");
now += 29000;
run("updateCountdown();");
assert.equal(
  run("scene"),
  "board",
  "Countdown returns automatically at 30 seconds",
);
console.log(
  "Display navigation and countdown passed: Back/Forward, preserved scores, logo exit, stale-history protection and automatic 30-second return.",
);
