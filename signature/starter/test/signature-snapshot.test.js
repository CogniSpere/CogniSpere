import fs from 'fs';
import assert from 'assert';
import path from 'path';

const sample = JSON.parse(fs.readFileSync('./examples/sample-signature.json', 'utf-8'));
const schema = JSON.parse(fs.readFileSync('./schema/signature.schema.json', 'utf-8'));

describe('Signature Snapshot Validation', () => {
  it('has required keys', () => {
    ['authenticity', 'confidence', 'context', 'trace'].forEach(key => {
      assert(sample[key], `Missing key: ${key}`);
    });
  });

  it('authenticity must include "signedBy"', () => {
    assert(sample.authenticity.signedBy, 'authenticity.signedBy is required');
  });

  // More test cases could be added as needed
});
