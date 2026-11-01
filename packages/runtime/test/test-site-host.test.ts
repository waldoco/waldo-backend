import { describe, expect, it } from 'vitest';
import { testSiteHost } from '../src/security/test-site';

// A test or staging copy of a site (a bank's uat. host) is not where a fact like a helpline number may come from.
describe('testSiteHost', () => {
  it.each([
    'https://uat.axisbank.com/support/home?utm_source=openai',
    'https://uat2.example.com/a',
    'https://staging-api.example.io/',
    'https://www.qa.example.co.uk/x',
    'https://preprod.example.com',
    'https://SANDBOX.Example.com/',
  ])('names the host of a test site: %s', (url) => {
    expect(testSiteHost(url)).toBe(new URL(url).hostname);
  });
  it.each([
    'https://www.axisbank.com/contact-us',
    'https://dev.to/post',
    'https://developer.apple.com/',
    'https://test.com/',
    'https://www.nhlbi.nih.gov/health/insomnia',
    'https://staging.com/',
    'not a url',
  ])('leaves a public site or a non-URL alone: %s', (url) => {
    expect(testSiteHost(url)).toBeNull();
  });
});
