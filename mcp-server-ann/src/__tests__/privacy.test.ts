import { describe, it, expect } from 'vitest';
import { redactOutboundText, validateOutboundText } from '../privacy.js';

describe('Outbound privacy filtering', () => {
  it('redacts common secret and local path patterns', () => {
    const redacted = redactOutboundText('token=abc123456789012345 /Users/alice/project/.env');
    expect(redacted).toContain('[redacted-secret]');
    expect(redacted).toContain('[redacted-local-path]');
  });

  it('strict mode blocks sensitive outbound content', () => {
    expect(() =>
      validateOutboundText('content', 'OPENAI_API_KEY=sk_test_12345678901234567890', 'strict')
    ).toThrow('appears to contain secrets');
  });

  it('balanced mode redacts instead of blocking', () => {
    expect(validateOutboundText('content', 'password=hunter2', 'balanced')).toBe('[redacted-secret]');
  });
});
