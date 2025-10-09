#!/usr/bin/env node
const fs = require('fs');

const args = process.argv.slice(2);
const options = {};
args.forEach((arg, i) => {
  if (arg.startsWith('--')) {
    options[arg.slice(2)] = args[i + 1];
  }
});

const signature = {
  "@signature": {
    "mode": options.mode || "reflective",
    "components": {
      "sig:modality": options.modality,
      "sig:reasoningHeuristic": options.reasoningHeuristic,
      "sig:confidenceModeling": options.confidenceModeling,
      "sig:sourceAttribution": options.sourceAttribution,
      "sig:intentDeclaration": options.intentDeclaration
    },
    "generatedBy": "signator-cli",
    "timestamp": new Date().toISOString()
  }
};

fs.writeFileSync('output_signature.json', JSON.stringify(signature, null, 2));
console.log('Signature written to output_signature.json');
