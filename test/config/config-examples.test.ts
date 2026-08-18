import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseConfig } from "../../src/providers/ones/ones-config.js";

const examples = [
  { file: "clawer-ticket.config.browser.example.json", profile: "ones-browser-my-open", source: "browser" },
  { file: "clawer-ticket.config.graphql.example.json", profile: "ones-graphql-my-open", source: "graphql" },
  { file: "clawer-ticket.config.example.json", profile: "ones-browser-my-open", source: "browser" },
] as const;

for (const example of examples) {
  const raw = JSON.parse(await readFile(new URL(`../../config/${example.file}`, import.meta.url), "utf8")) as unknown;
  const config = parseConfig(raw);
  assert.equal(config.profiles[example.profile]?.source, example.source, `${example.file} should expose its documented profile`);
}

const browserExample = parseConfig(JSON.parse(await readFile(new URL("../../config/clawer-ticket.config.browser.example.json", import.meta.url), "utf8")) as unknown);
const browserProfile = browserExample.profiles["ones-browser-my-open"]!;
assert.equal(browserProfile.requestBudget.maxConcurrent, 3);
assert.equal(browserProfile.requestBudget.maxRequestsPerMinute, 20);
assert.equal(browserProfile.browser?.autoLogin?.email, "replace-with-local-login@example.com");
assert.equal(browserProfile.browser?.autoLogin?.password, "REPLACE_WITH_LOCAL_PASSWORD");
assert.equal("listAssigneeFieldId" in browserProfile, false);
assert.deepEqual(browserExample.storage.exportLimits, {
  autoDownloadThreshold: 50,
  maxItems: 2_000,
  maxAttachments: 500,
  maxAttachmentBytes: 50 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

const referenceExample = parseConfig(JSON.parse(await readFile(new URL("../../config/clawer-ticket.config.example.json", import.meta.url), "utf8")) as unknown);
const referenceGraphql = referenceExample.profiles["ones-graphql-my-open"]!;
const referenceBrowser = referenceExample.profiles["ones-browser-my-open"]!;
assert.equal(referenceGraphql.classificationRules[0]?.fieldId, "REPLACE_WITH_CLASSIFICATION_FIELD_UUID");
assert.equal(referenceBrowser.browser?.autoLogin?.loginUrl, "https://tickets.example.com/login");
assert.equal("defaultView" in referenceGraphql, false);
assert.equal("myOpenViewUrl" in (referenceBrowser.browser ?? {}), false);

assert.throws(
  () => parseConfig({
    schemaVersion: "1.0",
    storage: { root: "D:/ticket-exports", exportLimits: { maxItems: 2_001 } },
    profiles: {
      browser: {
        source: "browser",
        product: "project",
        baseUrl: "https://tickets.example.com",
        teamId: "team",
        allowedHosts: ["tickets.example.com"],
      },
    },
  }),
  /Invalid configuration: storage.exportLimits.maxItems/,
  "configuration must reject a maxItems value above the 2,000 hard limit",
);

assert.throws(
  () => parseConfig({
    schemaVersion: "1.0",
    storage: { root: "D:/ticket-exports", exportLimits: { autoDownloadThreshold: 51, maxItems: 50 } },
    profiles: {
      browser: {
        source: "browser",
        product: "project",
        baseUrl: "https://tickets.example.com",
        teamId: "team",
        allowedHosts: ["tickets.example.com"],
      },
    },
  }),
  /Invalid configuration: storage.exportLimits.autoDownloadThreshold/,
  "configuration must reject an automatic threshold above maxItems",
);

console.log("Public configuration examples validate against the runtime schema.");
