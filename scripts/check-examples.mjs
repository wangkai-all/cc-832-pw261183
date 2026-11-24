#!/usr/bin/env node
// Verifies the JSON reference cases under examples/. These files use either the
// POST /api/jobs payload shape, a single { config, expect } wrapper, or a
// { cases: [...] } wrapper.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeModel } from '../src/core/analyzer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = path.join(root, 'examples');

function casesFromDocument(doc, file) {
  if (Array.isArray(doc.cases)) return doc.cases;
  if (doc.config) {
    return [{
      name: doc.id || path.basename(file, '.json'),
      config: doc.config,
      expect: doc.expect,
      expectError: doc.expectError,
    }];
  }
  if (typeof doc.expression === 'string') {
    return [{ name: path.basename(file, '.json'), config: doc }];
  }
  return [];
}

let checked = 0;
const failures = [];

for (const file of readdirSync(examplesDir).filter((name) => name.endsWith('.json')).sort()) {
  const absolute = path.join(examplesDir, file);
  const doc = JSON.parse(readFileSync(absolute, 'utf8'));
  for (const testCase of casesFromDocument(doc, file)) {
    checked += 1;
    const label = `${file}${testCase.name ? ` / ${testCase.name}` : ''}`;
    try {
      const result = analyzeModel(testCase.config, {
        budget: testCase.config?.budget ?? 32,
        sampleCount: 0,
      });
      if (testCase.expectError) {
        failures.push(`${label}: expected ${testCase.expectError}, but analysis completed`);
        console.error(`FAIL ${label}: unexpected completion`);
        continue;
      }
      const expectedRange = testCase.expect?.correlated;
      if (expectedRange) {
        const [expectedLo, expectedHi] = expectedRange;
        const actual = result.correlated.certified;
        if (
          Math.abs(actual.lo - expectedLo) > 1e-6 ||
          Math.abs(actual.hi - expectedHi) > 1e-6
        ) {
          failures.push(`${label}: expected [${expectedLo}, ${expectedHi}], got [${actual.lo}, ${actual.hi}]`);
          console.error(`FAIL ${label}: ${failures.at(-1)}`);
          continue;
        }
      }
      console.log(`PASS ${label}: ${JSON.stringify(result.correlated.certified)}`);
    } catch (error) {
      if (testCase.expectError && error.code === testCase.expectError) {
        console.log(`PASS ${label}: blocked with ${error.code}`);
      } else {
        failures.push(`${label}: ${error.code || 'ERROR'} ${error.message}`);
        console.error(`FAIL ${label}:`, error.code, error.message);
      }
    }
  }
}

console.log(`\nVerified ${checked} example case(s); ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
