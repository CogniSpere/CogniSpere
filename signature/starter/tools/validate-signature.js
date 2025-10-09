const fs = require('fs');

const schema = require('../schema/signatureComponents.v1.json');
const signature = require('../examples/example-signature-output.json');

const definedComponents = schema.components.map(c => c.id);
const input = signature["@signature"].components;

const issues = [];

for (const key in input) {
  if (!definedComponents.includes(key)) {
    issues.push(`Unknown component: ${key}`);
  }
}

if (issues.length) {
  console.error("Validation errors:");
  console.error(issues.join("\n"));
  process.exit(1);
} else {
  console.log("Signature is valid ✅");
}
