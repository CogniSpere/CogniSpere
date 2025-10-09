import fs from 'fs';

const fixture = {
  authenticity: {
    signedBy: "ThunderstrikerAI",
    signatureHash: "abc123def456",
    method: "SHA256"
  },
  confidence: {
    level: 0.98,
    margin: 0.01
  },
  context: {
    origin: "cerebrolusion.xyz",
    runtime: "o4-mini",
    timestamp: new Date().toISOString()
  },
  trace: {
    sourceChain: ["init", "self-check", "moderation", "publish"],
    ops: ["tokenize", "infer", "summarize"]
  }
};

fs.writeFileSync('./examples/sample-signature.json', JSON.stringify(fixture, null, 2));
console.log("Fixture saved.");
