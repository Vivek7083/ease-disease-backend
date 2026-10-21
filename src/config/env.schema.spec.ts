import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

describe('envSchema', () => {
  const validEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  };

  /** What a deployed (staging / production) environment must also carry, so other tests can isolate their own variable. */
  const TICK = { TICK_AUDIENCE: 'https://api.easedisease.in', TICK_SERVICE_ACCOUNT_EMAIL: 'scheduler@easedisease-prod.iam.gserviceaccount.com' };
  const FIREBASE = { FIREBASE_PROJECT_ID: 'easedisease-prod' };

  it('accepts a fully valid config and coerces PORT to a number', () => {
    const result = envSchema.parse(validEnv);
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
  });

  it('defaults NODE_ENV to development and PORT to 3000 when omitted', () => {
    const { NODE_ENV: _NODE_ENV, PORT: _PORT, ...rest } = validEnv;
    const result = envSchema.parse(rest);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = validEnv;
    expect(() => envSchema.parse(rest)).toThrow();
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => envSchema.parse({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow();
  });

  it('rejects an invalid NODE_ENV value', () => {
    expect(() => envSchema.parse({ ...validEnv, NODE_ENV: 'not-a-real-env' })).toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => envSchema.parse({ ...validEnv, PORT: 'not-a-port' })).toThrow();
  });

  describe('FRONTEND_BASE_URL and TRUST_PROXY_HOPS', () => {
    const prod = { ...validEnv, NODE_ENV: 'production', PAYU_KEY: 'k', PAYU_SALT: 's', API_PUBLIC_URL: 'https://api.easedisease.in', ...TICK, ...FIREBASE };

    it('are optional in development and default TRUST_PROXY_HOPS to 0', () => {
      const result = envSchema.parse(validEnv);
      expect(result.FRONTEND_BASE_URL).toBeUndefined();
      expect(result.TRUST_PROXY_HOPS).toBe(0);
    });

    it.each([
      ['http://localhost:4200', 'http://localhost:4200'],
      ['http://localhost:4200/', 'http://localhost:4200'],
      ['https://easedisease.in', 'https://easedisease.in'],
      ['HTTPS://EaseDisease.in', 'https://easedisease.in'],
    ])('normalises %s to %s', (input, expected) => {
      expect(envSchema.parse({ ...validEnv, FRONTEND_BASE_URL: input }).FRONTEND_BASE_URL).toBe(expected);
    });

    it.each([
      'not a url',
      'javascript:alert(1)',
      'ftp://easedisease.in',
      'https://easedisease.in/app',
      'https://easedisease.in///',
      'https://easedisease.in/?x=1',
      'https://easedisease.in/#frag',
      'https://user:pass@easedisease.in',
      '',
    ])('rejects %j', (input) => {
      expect(() => envSchema.parse({ ...validEnv, FRONTEND_BASE_URL: input })).toThrow();
    });

    it.each(['staging', 'production'])('is required when NODE_ENV is %s, and must be https', (nodeEnv) => {
      const env = { ...prod, NODE_ENV: nodeEnv };
      expect(() => envSchema.parse(env)).toThrow();
      expect(() => envSchema.parse({ ...env, FRONTEND_BASE_URL: 'http://easedisease.in' })).toThrow();
      expect(envSchema.parse({ ...env, FRONTEND_BASE_URL: 'https://easedisease.in' }).FRONTEND_BASE_URL).toBe('https://easedisease.in');
    });

    it.each([['0', 0], ['1', 1], ['5', 5], ['', 0]])('accepts TRUST_PROXY_HOPS=%j (a blank value means 0, the safe default)', (input, expected) => {
      expect(envSchema.parse({ ...validEnv, TRUST_PROXY_HOPS: input }).TRUST_PROXY_HOPS).toBe(expected);
    });

    it.each(['-1', '6', '1.5', 'many'])('rejects TRUST_PROXY_HOPS=%j', (input) => {
      expect(() => envSchema.parse({ ...validEnv, TRUST_PROXY_HOPS: input })).toThrow();
    });
  });

  describe('API_PUBLIC_URL', () => {
    const deployed = { ...validEnv, PAYU_KEY: 'k', PAYU_SALT: 's', FRONTEND_BASE_URL: 'https://easedisease.in', ...TICK, ...FIREBASE };

    it('is optional in development', () => {
      expect(envSchema.parse(validEnv).API_PUBLIC_URL).toBeUndefined();
    });

    it.each([
      ['http://localhost:3000', 'http://localhost:3000'],
      ['https://api.easedisease.in/', 'https://api.easedisease.in'],
      ['HTTPS://API-Staging.EaseDisease.in', 'https://api-staging.easedisease.in'],
    ])('normalises %s to %s', (input, expected) => {
      expect(envSchema.parse({ ...validEnv, API_PUBLIC_URL: input }).API_PUBLIC_URL).toBe(expected);
    });

    it.each(['javascript:alert(1)', 'https://api.easedisease.in/v1', 'https://api.easedisease.in/?x=1', 'https://u:p@api.easedisease.in', 'nope', ''])(
      'rejects %j',
      (input) => {
        expect(() => envSchema.parse({ ...validEnv, API_PUBLIC_URL: input })).toThrow();
      },
    );

    it.each(['staging', 'production'])('is required in %s, and must be https', (nodeEnv) => {
      const env = { ...deployed, NODE_ENV: nodeEnv };
      expect(() => envSchema.parse(env)).toThrow(/API_PUBLIC_URL/);
      expect(() => envSchema.parse({ ...env, API_PUBLIC_URL: 'http://api.easedisease.in' })).toThrow(/API_PUBLIC_URL/);
      expect(envSchema.parse({ ...env, API_PUBLIC_URL: 'https://api.easedisease.in' }).API_PUBLIC_URL).toBe('https://api.easedisease.in');
    });
  });

  describe('PayU config', () => {
    it('defaults PAYU_ENV to test and allows missing credentials in development', () => {
      const result = envSchema.parse(validEnv);
      expect(result.PAYU_ENV).toBe('test');
      expect(result.PAYU_KEY).toBeUndefined();
      expect(result.PAYU_SALT).toBeUndefined();
    });

    it.each(['staging', 'production'])('requires PAYU_KEY and PAYU_SALT when NODE_ENV is %s', (nodeEnv) => {
      // A valid FRONTEND_BASE_URL is always present here, so only the PayU credentials can be the reason for a failure.
      const deployed = { ...validEnv, NODE_ENV: nodeEnv, FRONTEND_BASE_URL: 'https://easedisease.in', API_PUBLIC_URL: 'https://api.easedisease.in', ...TICK, ...FIREBASE };
      expect(() => envSchema.parse(deployed)).toThrow(/PAYU_KEY/);
      expect(() => envSchema.parse({ ...deployed, PAYU_KEY: 'k' })).toThrow(/PAYU_SALT/);
      expect(() => envSchema.parse({ ...deployed, PAYU_SALT: 's' })).toThrow(/PAYU_KEY/);
      expect(envSchema.parse({ ...deployed, PAYU_KEY: 'k', PAYU_SALT: 's' }).PAYU_KEY).toBe('k');
    });

    it('rejects empty credential strings', () => {
      expect(() => envSchema.parse({ ...validEnv, PAYU_KEY: '' })).toThrow();
    });

    it('rejects an unknown PAYU_ENV', () => {
      expect(() => envSchema.parse({ ...validEnv, PAYU_ENV: 'sandbox' })).toThrow();
    });

    it('only allows PAYU_ENV=live in production', () => {
      const creds = { PAYU_KEY: 'k', PAYU_SALT: 's', PAYU_ENV: 'live' };
      const frontend = { FRONTEND_BASE_URL: 'https://easedisease.in', API_PUBLIC_URL: 'https://api.easedisease.in', ...TICK, ...FIREBASE };
      expect(() => envSchema.parse({ ...validEnv, ...creds })).toThrow(/PAYU_ENV=live/);
      expect(() => envSchema.parse({ ...validEnv, ...creds, ...frontend, NODE_ENV: 'staging' })).toThrow(/PAYU_ENV=live/);
      expect(envSchema.parse({ ...validEnv, ...creds, ...frontend, NODE_ENV: 'production' }).PAYU_ENV).toBe('live');
    });
  });

  describe('tick (Cloud Scheduler OIDC) config', () => {
    const deployed = { ...validEnv, PAYU_KEY: 'k', PAYU_SALT: 's', FRONTEND_BASE_URL: 'https://easedisease.in', API_PUBLIC_URL: 'https://api.easedisease.in', ...FIREBASE };

    it('is optional in development and test', () => {
      for (const NODE_ENV of ['development', 'test']) {
        const result = envSchema.parse({ ...validEnv, NODE_ENV });
        expect(result.TICK_AUDIENCE).toBeUndefined();
        expect(result.TICK_SERVICE_ACCOUNT_EMAIL).toBeUndefined();
      }
    });

    it.each(['staging', 'production'])('requires both variables when NODE_ENV is %s', (nodeEnv) => {
      const env = { ...deployed, NODE_ENV: nodeEnv };
      expect(() => envSchema.parse(env)).toThrow(/TICK_AUDIENCE/);
      expect(() => envSchema.parse({ ...env, TICK_AUDIENCE: TICK.TICK_AUDIENCE })).toThrow(/TICK_SERVICE_ACCOUNT_EMAIL/);
      expect(() => envSchema.parse({ ...env, TICK_SERVICE_ACCOUNT_EMAIL: TICK.TICK_SERVICE_ACCOUNT_EMAIL })).toThrow(/TICK_AUDIENCE/);
      expect(envSchema.parse({ ...env, ...TICK }).TICK_AUDIENCE).toBe(TICK.TICK_AUDIENCE);
    });

    it.each(['staging', 'production'])('requires an https audience in %s', (nodeEnv) => {
      expect(() => envSchema.parse({ ...deployed, ...TICK, NODE_ENV: nodeEnv, TICK_AUDIENCE: 'http://api.easedisease.in' })).toThrow(/TICK_AUDIENCE must use https/);
    });

    it('outside deployed environments the two must be set together', () => {
      expect(() => envSchema.parse({ ...validEnv, TICK_AUDIENCE: 'http://localhost:3000' })).toThrow(/TICK_SERVICE_ACCOUNT_EMAIL/);
      expect(() => envSchema.parse({ ...validEnv, TICK_SERVICE_ACCOUNT_EMAIL: TICK.TICK_SERVICE_ACCOUNT_EMAIL })).toThrow(/TICK_AUDIENCE/);
      expect(envSchema.parse({ ...validEnv, TICK_AUDIENCE: 'http://localhost:3000', TICK_SERVICE_ACCOUNT_EMAIL: TICK.TICK_SERVICE_ACCOUNT_EMAIL }).TICK_AUDIENCE).toBe('http://localhost:3000');
    });

    it('lower-cases the service account email, and rejects things that are not emails or URLs', () => {
      expect(envSchema.parse({ ...validEnv, ...TICK, TICK_SERVICE_ACCOUNT_EMAIL: 'Scheduler@EaseDisease-Prod.iam.gserviceaccount.com' }).TICK_SERVICE_ACCOUNT_EMAIL).toBe(
        'scheduler@easedisease-prod.iam.gserviceaccount.com',
      );
      expect(() => envSchema.parse({ ...validEnv, ...TICK, TICK_SERVICE_ACCOUNT_EMAIL: 'not-an-email' })).toThrow();
      expect(() => envSchema.parse({ ...validEnv, ...TICK, TICK_AUDIENCE: 'not a url' })).toThrow();
      expect(() => envSchema.parse({ ...validEnv, ...TICK, TICK_AUDIENCE: '' })).toThrow();
    });
  });

  describe('Firebase sign-in config', () => {
    /** Everything else a deployed environment needs, so only the Firebase variable under test can be the reason for a failure. */
    const deployed = {
      ...validEnv,
      PAYU_KEY: 'k',
      PAYU_SALT: 's',
      FRONTEND_BASE_URL: 'https://easedisease.in',
      API_PUBLIC_URL: 'https://api.easedisease.in',
      ...TICK,
      ...FIREBASE,
    };
    const DEPLOYED_ENVS = ['staging', 'production'];
    const LOCAL_ENVS = ['development', 'test'];

    describe('FIREBASE_PROJECT_ID', () => {
      it.each(LOCAL_ENVS)('is optional in %s', (nodeEnv) => {
        expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv }).FIREBASE_PROJECT_ID).toBeUndefined();
      });

      it.each(DEPLOYED_ENVS)('is accepted in %s when valid', (nodeEnv) => {
        expect(envSchema.parse({ ...deployed, NODE_ENV: nodeEnv }).FIREBASE_PROJECT_ID).toBe('easedisease-prod');
      });

      it.each(DEPLOYED_ENVS)('is required in %s, and the error names the variable', (nodeEnv) => {
        const { FIREBASE_PROJECT_ID: _removed, ...withoutId } = deployed;
        expect(() => envSchema.parse({ ...withoutId, NODE_ENV: nodeEnv })).toThrow(/FIREBASE_PROJECT_ID is required/);
      });

      it.each(DEPLOYED_ENVS)('a blank value counts as missing in %s', (nodeEnv) => {
        expect(() => envSchema.parse({ ...deployed, NODE_ENV: nodeEnv, FIREBASE_PROJECT_ID: '' })).toThrow(/FIREBASE_PROJECT_ID is required/);
        expect(() => envSchema.parse({ ...deployed, NODE_ENV: nodeEnv, FIREBASE_PROJECT_ID: '   ' })).toThrow(/FIREBASE_PROJECT_ID is required/);
      });

      it.each(LOCAL_ENVS)('a blank value (a copied "FIREBASE_PROJECT_ID=" line) counts as not set in %s', (nodeEnv) => {
        expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, FIREBASE_PROJECT_ID: '' }).FIREBASE_PROJECT_ID).toBeUndefined();
      });

      it.each([
        ['easedisease-staging'],
        ['easedisease-prod'],
        ['demo-local'],
        ['abcdef'], // 6 characters, the shortest
        ['a'.repeat(29) + 'b'], // 30 characters, the longest
        ['project-123456'],
        ['a1b2c3'],
      ])('accepts %s', (id) => {
        expect(envSchema.parse({ ...validEnv, FIREBASE_PROJECT_ID: id }).FIREBASE_PROJECT_ID).toBe(id);
      });

      it('trims surrounding whitespace', () => {
        expect(envSchema.parse({ ...validEnv, FIREBASE_PROJECT_ID: '  easedisease-prod \n' }).FIREBASE_PROJECT_ID).toBe('easedisease-prod');
      });

      it.each([
        ['upper-case letters', 'EaseDisease-Prod'],
        ['an underscore', 'ease_disease'],
        ['a space inside', 'ease disease'],
        ['a leading digit', '1easedisease'],
        ['a leading hyphen', '-easedisease'],
        ['a trailing hyphen', 'easedisease-'],
        ['5 characters (too short)', 'abcde'],
        ['31 characters (too long)', 'a'.repeat(30) + 'b'],
        ['a URL', 'https://easedisease-prod.firebaseapp.com'],
        ['a path', 'projects/easedisease-prod'],
        ['a dot', 'easedisease.prod'],
        ['an embedded newline', 'easedisease\nprod'],
      ])('rejects an id with %s, in every environment', (_label, id) => {
        for (const nodeEnv of [...LOCAL_ENVS, ...DEPLOYED_ENVS]) {
          expect(() => envSchema.parse({ ...deployed, NODE_ENV: nodeEnv, FIREBASE_PROJECT_ID: id })).toThrow(/FIREBASE_PROJECT_ID/);
        }
      });
    });

    describe('APP_CHECK_MODE', () => {
      it.each([...LOCAL_ENVS, ...DEPLOYED_ENVS])('defaults to enforce in %s', (nodeEnv) => {
        expect(envSchema.parse({ ...deployed, NODE_ENV: nodeEnv }).APP_CHECK_MODE).toBe('enforce');
      });

      it.each([...LOCAL_ENVS, ...DEPLOYED_ENVS])('accepts enforce in %s', (nodeEnv) => {
        expect(envSchema.parse({ ...deployed, NODE_ENV: nodeEnv, APP_CHECK_MODE: 'enforce' }).APP_CHECK_MODE).toBe('enforce');
      });

      it.each(LOCAL_ENVS)('accepts off in %s', (nodeEnv) => {
        expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, APP_CHECK_MODE: 'off' }).APP_CHECK_MODE).toBe('off');
      });

      it.each(DEPLOYED_ENVS)('refuses off in %s, and the error names the variable', (nodeEnv) => {
        expect(() => envSchema.parse({ ...deployed, NODE_ENV: nodeEnv, APP_CHECK_MODE: 'off' })).toThrow(/APP_CHECK_MODE=off is not allowed/);
      });

      it.each(['OFF', 'Enforce', 'false', 'disabled', '0', 'on', '', ' '])('rejects the value %j (only enforce and off exist)', (value) => {
        expect(() => envSchema.parse({ ...validEnv, APP_CHECK_MODE: value })).toThrow(/APP_CHECK_MODE/);
      });
    });

    describe('FIREBASE_AUTH_EMULATOR_HOST', () => {
      it.each(LOCAL_ENVS)('is optional in %s', (nodeEnv) => {
        expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv }).FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
      });

      it.each([['localhost:9099'], ['127.0.0.1:9099'], ['[::1]:9099'], ['emulator.internal:1'], ['localhost:65535']])('accepts %s in development and test', (host) => {
        for (const nodeEnv of LOCAL_ENVS) {
          expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, FIREBASE_AUTH_EMULATOR_HOST: host }).FIREBASE_AUTH_EMULATOR_HOST).toBe(host);
        }
      });

      it.each(LOCAL_ENVS)('a blank value is tolerated in %s (the SDK treats it as unset)', (nodeEnv) => {
        expect(envSchema.parse({ ...validEnv, NODE_ENV: nodeEnv, FIREBASE_AUTH_EMULATOR_HOST: '' }).FIREBASE_AUTH_EMULATOR_HOST).toBe('');
      });

      it.each([
        ['a scheme', 'http://localhost:9099'],
        ['no port', 'localhost'],
        ['no host', ':9099'],
        ['a non-numeric port', 'localhost:abc'],
        ['port 0', 'localhost:0'],
        ['a port above 65535', 'localhost:65536'],
        ['a very large port', 'localhost:99999'],
        ['a space', 'local host:9099'],
        ['a path', 'localhost:9099/auth'],
      ])('rejects %s in development', (_label, host) => {
        expect(() => envSchema.parse({ ...validEnv, FIREBASE_AUTH_EMULATOR_HOST: host })).toThrow(/FIREBASE_AUTH_EMULATOR_HOST must be host:port/);
      });

      it.each(DEPLOYED_ENVS)('is refused in %s whenever it is present: valid, malformed or blank', (nodeEnv) => {
        for (const host of ['localhost:9099', '10.0.0.5:9099', 'garbage', '']) {
          expect(() => envSchema.parse({ ...deployed, NODE_ENV: nodeEnv, FIREBASE_AUTH_EMULATOR_HOST: host })).toThrow(/FIREBASE_AUTH_EMULATOR_HOST must not be set/);
        }
      });

      it.each(DEPLOYED_ENVS)('is not a problem in %s when absent', (nodeEnv) => {
        expect(envSchema.parse({ ...deployed, NODE_ENV: nodeEnv }).FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
      });
    });
  });
});
