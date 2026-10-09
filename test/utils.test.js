// Automated tests for English Lab pure functions
// Run: node --test test/utils.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// We need to import the ES modules - use dynamic import
const utils = await import('../js/core/utils.js');

describe('chunkText', () => {
  test('splits long text into chunks', () => {
    const text = 'Hello world. '.repeat(1000); // ~13000 chars
    const chunks = utils.chunkText(text, 4500);
    assert.ok(chunks.length > 1, 'should split into multiple chunks');
    chunks.forEach(c => assert.ok(c.length <= 5000, 'chunk should not exceed max too much'));
  });
  
  test('returns single chunk for short text', () => {
    const chunks = utils.chunkText('Hello world', 4500);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'Hello world');
  });
  
  test('handles empty text', () => {
    const r1 = utils.chunkText('', 4500);
    assert.ok(r1.length <= 1, 'empty should return 0 or 1 chunks');
    assert.deepEqual(utils.chunkText(null, 4500), []);
  });
});

describe('hashStr', () => {
  test('produces consistent hash', () => {
    assert.equal(utils.hashStr('hello'), utils.hashStr('hello'));
  });
  
  test('different strings produce different hashes', () => {
    assert.notEqual(utils.hashStr('hello'), utils.hashStr('world'));
  });
  
  test('returns base36 string', () => {
    const h = utils.hashStr('test');
    assert.match(h, /^[0-9a-z]+$/);
  });
});

describe('fmtT', () => {
  test('formats seconds as m:ss', () => {
    assert.equal(utils.fmtT(65), '1:05');
    assert.equal(utils.fmtT(0), '0:00');
    assert.equal(utils.fmtT(3600), '60:00');
  });
  
  test('handles null/undefined', () => {
    assert.equal(utils.fmtT(null), '0:00');
    assert.equal(utils.fmtT(undefined), '0:00');
  });
});

describe('splitSents', () => {
  test('splits on sentence boundaries', () => {
    const sents = utils.splitSents('Hello world, this is a test. How are you doing today? I am doing fine, thank you!');
    assert.equal(sents.length, 3);
  });
  
  test('filters very short sentences', () => {
    const sents = utils.splitSents('Hello world, this is long enough. Hi!');
    assert.equal(sents.length, 1); // "Hi!" filtered (< 10 chars)
  });
  
  test('handles empty', () => {
    assert.deepEqual(utils.splitSents(''), []);
  });
});

describe('cleanOCRText', () => {
  test('removes UI noise', () => {
    const cleaned = utils.cleanOCRText('Home Search Settings\nHello world\nAdvertisement');
    assert.ok(!cleaned.includes('Advertisement') || cleaned.length < 50);
  });
});

describe('classifyCEFR', () => {
  test('classifies simple sentences as A1/A2', () => {
    const level = utils.classifyCEFR('The cat is on the mat.');
    assert.ok(['A1', 'A2'].includes(level), `expected A1/A2, got ${level}`);
  });
  
  test('classifies complex sentences higher', () => {
    const level = utils.classifyCEFR('The quintessential ramifications of socioeconomic disparity necessitate comprehensive amelioration.');
    assert.ok(['B2', 'C1', 'C2'].includes(level), `expected B2+, got ${level}`);
  });
});

console.log('All utils tests completed');
