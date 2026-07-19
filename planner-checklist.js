#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const VALID_STATUSES = new Set(["pending", "in_progress", "blocked", "completed", "skipped"]);
const VALID_TYPES = new Set(["investigation", "design", "implementation", "validation", "integration"]);
const PHASE_ID = /^P-\d{3}(?:-[A-Z]+)?$/;
const REQUIRED = [
  "id",
  "title",
  "status",
  "phase_type",
  "entry_criteria",
  "exit_criteria",
  "dependencies",
  "requirements",
  "subagent",
];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`planner-checklist

Usage:
  node ./planner-checklist.js list [plan-slug-or-path]
  node ./planner-checklist.js remaining [plan-slug-or-path]
  node ./planner-checklist.js next [plan-slug-or-path]
  node ./planner-checklist.js status [plan-slug-or-path] <PHASE_ID>
  node ./planner-checklist.js start [plan-slug-or-path] <PHASE_ID>
  node ./planner-checklist.js complete [plan-slug-or-path] <PHASE_ID>
  node ./planner-checklist.js block [plan-slug-or-path] <PHASE_ID>
  node ./planner-checklist.js reset [plan-slug-or-path] <PHASE_ID>
  node ./planner-checklist.js skip [plan-slug-or-path] <PHASE_ID>
  node ./planner-checklist.js export [plan-slug-or-path]

Phase frontmatter under .plans/<slug>/phases/*.md is the source of truth.`);
}

function discoverPlans() {
  const plansRoot = path.join(ROOT, ".plans");
  if (!fs.existsSync(plansRoot)) return [];
  return fs
    .readdirSync(plansRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(plansRoot, entry.name, "phases")))
    .map((entry) => path.join(plansRoot, entry.name));
}

function resolvePlan(ref) {
  if (!ref) {
    const plans = discoverPlans();
    if (plans.length === 1) return plans[0];
    if (plans.length === 0) fail("No structured plans found under .plans/");
    fail("Multiple structured plans found; pass a slug or path");
  }
  const direct = path.resolve(ROOT, ref);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  const bySlug = path.join(ROOT, ".plans", ref);
  if (fs.existsSync(bySlug) && fs.statSync(bySlug).isDirectory()) return bySlug;
  fail(`Plan folder not found: ${ref}`);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePhase(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.startsWith("---\n")) fail(`Missing frontmatter: ${file}`);
  const end = raw.indexOf("\n---", 4);
  if (end < 0) fail(`Unclosed frontmatter: ${file}`);
  const frontmatter = {};
  for (const sourceLine of raw.slice(4, end).split("\n")) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) fail(`Invalid frontmatter line in ${file}: ${sourceLine}`);
    const key = line.slice(0, separator).trim();
    frontmatter[key] = parseScalar(line.slice(separator + 1));
  }
  return {
    ...frontmatter,
    file: path.basename(file),
    _path: file,
    _raw: raw,
  };
}

function loadPlan(ref) {
  const planDir = resolvePlan(ref);
  const phasesDir = path.join(planDir, "phases");
  if (!fs.existsSync(phasesDir)) fail(`Missing phases directory: ${phasesDir}`);
  const phases = fs
    .readdirSync(phasesDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parsePhase(path.join(phasesDir, name)));
  if (phases.length === 0) fail(`No phase files found in ${phasesDir}`);

  const ids = new Set();
  for (const phase of phases) {
    for (const field of REQUIRED) {
      if (!(field in phase)) fail(`Phase ${phase.file} missing ${field}`);
    }
    if (!PHASE_ID.test(phase.id)) fail(`Invalid phase id ${phase.id} in ${phase.file}`);
    if (ids.has(phase.id)) fail(`Duplicate phase id ${phase.id}`);
    ids.add(phase.id);
    if (!VALID_STATUSES.has(phase.status)) fail(`Invalid status ${phase.status} for ${phase.id}`);
    if (!VALID_TYPES.has(phase.phase_type)) fail(`Invalid phase_type ${phase.phase_type} for ${phase.id}`);
    if (!Array.isArray(phase.dependencies)) fail(`dependencies must be an array for ${phase.id}`);
    if (!Array.isArray(phase.requirements) || phase.requirements.length === 0) {
      fail(`requirements must be a non-empty array for ${phase.id}`);
    }
  }
  for (const phase of phases) {
    for (const dependency of phase.dependencies) {
      if (!ids.has(dependency)) fail(`${phase.id} depends on unknown phase ${dependency}`);
    }
  }
  return { planDir, phases };
}

function publicPhase(phase) {
  const { _path, _raw, ...result } = phase;
  return result;
}

function format(phase) {
  const deps = phase.dependencies.length ? phase.dependencies.join(",") : "none";
  return `${phase.id}\t${phase.status}\t${phase.phase_type}\t${phase.title}\tphases/${phase.file}\tdeps:${deps}`;
}

function getPhase(plan, id) {
  const phase = plan.phases.find((item) => item.id === id);
  if (!phase) fail(`Phase not found: ${id}`);
  return phase;
}

function dependenciesSatisfied(plan, phase) {
  return phase.dependencies.every((id) => {
    const dependency = getPhase(plan, id);
    return dependency.status === "completed" || dependency.status === "skipped";
  });
}

function updateStatus(plan, id, status) {
  const phase = getPhase(plan, id);
  if (status === "in_progress" && !dependenciesSatisfied(plan, phase)) {
    fail(`Cannot start ${id}; dependencies are not completed`);
  }
  const updated = phase._raw.replace(/^status:\s*.*$/m, `status: ${status}`);
  if (updated === phase._raw) fail(`Could not update status field for ${id}`);
  fs.writeFileSync(phase._path, updated, "utf8");
}

function exportChecklist(plan) {
  const output = {
    version: 1,
    plan: path.basename(plan.planDir),
    mode: "structured",
    source: "phase-frontmatter",
    phases: plan.phases.map(publicPhase),
  };
  const stateDir = path.join(plan.planDir, ".state");
  fs.mkdirSync(stateDir, { recursive: true });
  const outputPath = path.join(stateDir, "checklist.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(outputPath);
}

function main() {
  const [, , command, planRef, maybeId] = process.argv;
  if (!command) {
    usage();
    return;
  }
  const plan = loadPlan(planRef);
  const commandsWithId = new Set(["status", "start", "complete", "block", "reset", "skip"]);
  if (commandsWithId.has(command) && !maybeId) fail(`${command} requires PHASE_ID`);

  switch (command) {
    case "list":
      plan.phases.forEach((phase) => console.log(format(phase)));
      return;
    case "remaining":
      plan.phases
        .filter((phase) => phase.status !== "completed" && phase.status !== "skipped")
        .forEach((phase) => console.log(format(phase)));
      return;
    case "next": {
      const ready = plan.phases.filter(
        (phase) => phase.status === "pending" && dependenciesSatisfied(plan, phase),
      );
      if (!ready.length) console.log("No ready phases found.");
      else ready.forEach((phase) => console.log(format(phase)));
      return;
    }
    case "status":
      console.log(JSON.stringify(publicPhase(getPhase(plan, maybeId)), null, 2));
      return;
    case "start":
      updateStatus(plan, maybeId, "in_progress");
      console.log(`Started ${maybeId}`);
      return;
    case "complete":
      updateStatus(plan, maybeId, "completed");
      console.log(`Completed ${maybeId}`);
      return;
    case "block":
      updateStatus(plan, maybeId, "blocked");
      console.log(`Blocked ${maybeId}`);
      return;
    case "reset":
      updateStatus(plan, maybeId, "pending");
      console.log(`Reset ${maybeId} to pending`);
      return;
    case "skip":
      updateStatus(plan, maybeId, "skipped");
      console.log(`Skipped ${maybeId}`);
      return;
    case "export":
      exportChecklist(plan);
      return;
    default:
      usage();
      fail(`Unknown command: ${command}`);
  }
}

main();
