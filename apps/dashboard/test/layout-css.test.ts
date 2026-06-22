import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const css = postcss.parse(styles);

function compact(value: string) {
  return value.replace(/\s+/g, "");
}

function topLevelRule(selector: string) {
  const rule = css.nodes.find((node): node is Rule => node.type === "rule" && node.selector === selector);
  assert.ok(rule, `Expected top-level ${selector} rule`);
  return rule;
}

function mediaRule(params: string) {
  const rule = css.nodes.find(
    (node): node is AtRule =>
      node.type === "atrule" && node.name === "media" && compact(node.params) === compact(params),
  );
  assert.ok(rule, `Expected @media ${params} rule`);
  return rule;
}

function nestedRule(container: AtRule, selector: string) {
  const rule = container.nodes?.find((node): node is Rule => node.type === "rule" && node.selector === selector);
  assert.ok(rule, `Expected ${selector} rule inside @media ${container.params}`);
  return rule;
}

function findDeclaration(rule: Rule, property: string) {
  return rule.nodes.find((node): node is Declaration => node.type === "decl" && node.prop === property);
}

function declaration(rule: Rule, property: string) {
  const decl = findDeclaration(rule, property);
  assert.ok(decl, `Expected ${property} declaration in ${rule.selector}`);
  return decl.value;
}

test("dashboard layout uses a wider responsive left pane", () => {
  const body = topLevelRule(".body");
  assert.equal(compact(declaration(body, "--left-pane-width")), "clamp(320px,26vw,460px)");
  assert.equal(
    compact(declaration(body, "grid-template-columns")),
    "var(--left-pane-width)minmax(0,1fr)var(--events-pane-width)",
  );

  const collapsedBody = topLevelRule(".body.right-pane-collapsed");
  assert.equal(
    compact(declaration(collapsedBody, "grid-template-columns")),
    "var(--left-pane-width)minmax(0,1fr)var(--events-handle-width)",
  );

  const events = topLevelRule(".events");
  assert.equal(compact(declaration(events, "max-width")), "calc(100vw-var(--left-pane-width))");
});

test("dashboard layout stacks panes on compact viewports", () => {
  const body = topLevelRule(".body");
  assert.equal(findDeclaration(body, "--main-pane-compact-min-width"), undefined);

  const compactLayout = mediaRule("(max-width: 768px)");
  const compactBody = nestedRule(compactLayout, ".body");
  assert.equal(compact(declaration(compactBody, "grid-template-columns")), "minmax(0,1fr)");
  assert.equal(compact(declaration(compactBody, "overflow")), "hidden");

  const openBody = nestedRule(compactLayout, ".body.right-pane-open");
  assert.equal(compact(declaration(openBody, "grid-template-columns")), "minmax(0,1fr)");
  assert.equal(
    compact(declaration(openBody, "grid-template-rows")),
    "minmax(0,auto)minmax(0,1fr)minmax(220px,38vh)",
  );

  const collapsedBody = nestedRule(compactLayout, ".body.right-pane-collapsed");
  assert.equal(compact(declaration(collapsedBody, "grid-template-columns")), "minmax(0,1fr)");
  assert.equal(
    compact(declaration(collapsedBody, "grid-template-rows")),
    "minmax(0,auto)minmax(0,1fr)var(--events-handle-width)",
  );

  const compactEvents = nestedRule(compactLayout, ".events");
  assert.equal(compact(declaration(compactEvents, "width")), "100%");
  assert.equal(compact(declaration(compactEvents, "max-width")), "none");
});
