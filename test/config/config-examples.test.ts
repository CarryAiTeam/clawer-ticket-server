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
assert.equal(browserProfile.requestBudget.maxConcurrent, 1);
assert.equal(browserProfile.requestBudget.maxRequestsPerMinute, 20);
assert.equal(browserProfile.browser?.autoLogin?.email, "replace-with-local-login@example.com");
assert.equal(browserProfile.browser?.autoLogin?.password, "REPLACE_WITH_LOCAL_PASSWORD");
assert.equal("listAssigneeFieldId" in browserProfile, false);

const referenceExample = parseConfig(JSON.parse(await readFile(new URL("../../config/clawer-ticket.config.example.json", import.meta.url), "utf8")) as unknown);
const referenceGraphql = referenceExample.profiles["ones-graphql-my-open"]!;
const referenceBrowser = referenceExample.profiles["ones-browser-my-open"]!;
assert.equal(referenceGraphql.classificationRules[0]?.fieldId, "REPLACE_WITH_CLASSIFICATION_FIELD_UUID");
assert.equal(referenceBrowser.browser?.autoLogin?.loginUrl, "https://tickets.example.com/login");
assert.equal("defaultView" in referenceGraphql, false);
assert.equal("myOpenViewUrl" in (referenceBrowser.browser ?? {}), false);

console.log("Public configuration examples validate against the runtime schema.");
