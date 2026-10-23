import { ChannelRegistry, preflight, type ChannelDefinition } from "@hypout/core";
import { ConfigError, loadConfig } from "../config";

export interface ValidateReport {
  ok: boolean;
  configFile: string | null;
  port: number;
  namespaces: Array<{ namespace: string; events: string[]; access: ChannelDefinition["access"]; retention: number }>;
  errors: string[];
  warnings: string[];
}

export function runValidate(cwd: string, file?: string): ValidateReport {
  const report: ValidateReport = { ok: true, configFile: null, port: 0, namespaces: [], errors: [], warnings: [] };
  try {
    const loaded = loadConfig(cwd, { ...(file ? { file } : {}), env: { ...process.env, HYPOUT_SECRET: process.env["HYPOUT_SECRET"] ?? "validate-only-secret-0000" } });
    report.configFile = loaded.file;
    report.port = loaded.config.port;
    if (!loaded.file) report.warnings.push("no hypout.config.json found; using defaults (run `hypout init`)");
    if (loaded.channels.length === 0) report.warnings.push(`no channel definitions in ${loaded.config.channels}/; every channel name will be refused (HP-101)`);
    const registry = new ChannelRegistry(loaded.channels);
    for (const def of registry.definitions()) {
      report.namespaces.push({ namespace: def.namespace, events: Object.keys(def.events), access: def.access, retention: def.retention.events });
      if (def.access.publish === "public") report.warnings.push(`${def.namespace}: anyone can publish, with no token (rate limit ${def.rateLimit.capacity} burst)`);
      if (Object.keys(def.events).length === 0) report.warnings.push(`${def.namespace}: no events declared, so any event name and payload is accepted (HP-102 cannot protect it)`);
      if (def.presence.maxMembers > 0 && def.access.presence === "off" && def.presence.maxMembers !== 1000) report.warnings.push(`${def.namespace}: presence.maxMembers is set but presence is off`);
      const probe = preflight(registry, { op: "sub", channel: def.namespace, principal: null, bytes: 10 });
      if (!probe.checks.find((c) => c.code === "HP-101")?.ok) report.errors.push(`${def.namespace}: its own name does not pass HP-101`);
    }
  } catch (e) {
    report.errors.push(e instanceof ConfigError || e instanceof Error ? e.message : String(e));
  }
  report.ok = report.errors.length === 0;
  return report;
}
