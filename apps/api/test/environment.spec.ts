import { validateEnvironment } from '../src/config/environment';

describe('validateEnvironment', () => {
  it('provides safe development defaults', () => {
    expect(validateEnvironment({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => validateEnvironment({ PORT: '70000' })).toThrow(
      'Invalid environment configuration',
    );
  });
});

