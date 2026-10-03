import { writeFileSync } from "node:fs";
import { REGISTRY } from "../src/arch/registry";

const cell = (text: string) => text.replace(/\|/g, "\\|");

const rows = REGISTRY.map((rule) => {
  const layer =
    "defaultLayer" in rule && rule.defaultLayer
      ? `\`${rule.defaultLayer}\``
      : "";
  const aliases = (rule.aliases ?? []).map((a) => `\`${a}\``).join(", ");
  return `| \`${rule.id}\` | ${rule.kind} | ${rule.defaultLevel === "off" ? "off" : "error"} | ${layer} | ${aliases} | ${cell(rule.description)} |`;
});

const text = `# Rules

Generated from the rule registry by \`npm run docs:rules\`. ${REGISTRY.length} rules.

Every rule is controlled from \`arch-lint.config.json\`: level, layer, include, exemptions and options. Options are listed in [RULE-OPTIONS.md](RULE-OPTIONS.md).

| Rule | Kind | Default level | Default layer | Older ids | What it enforces |
|---|---|---|---|---|---|
${rows.join("\n")}
`;

writeFileSync(new URL("../docs/RULES.md", import.meta.url), text);
process.stdout.write(`wrote docs/RULES.md (${REGISTRY.length} rules)\n`);
