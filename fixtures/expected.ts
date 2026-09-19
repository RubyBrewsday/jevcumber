import type { LocatorSpec, ResolvedStep } from '../src/types.js';

// Known-good resolutions for fixtures/features/login.feature, keyed by step text.
const email: LocatorSpec = { by: 'role', role: 'textbox', name: 'Email' };
const password: LocatorSpec = { by: 'label', value: 'Password' };
const logIn: LocatorSpec = { by: 'role', role: 'button', name: 'Log in' };
const newTodo: LocatorSpec = { by: 'role', role: 'textbox', name: 'New todo' };
const add: LocatorSpec = { by: 'role', role: 'button', name: 'Add' };
export const sees = (value: string): ResolvedStep => ({ kind: 'assert', assertion: { form: 'text_visible', value } });

export const RESOLVED: Record<string, ResolvedStep> = {
  'I am on "/login"': { kind: 'navigate', value: '/login' },
  'I fill in the email field with "alice@example.com"': { kind: 'fill', locator: email, value: 'alice@example.com' },
  'I fill in the password field with "secret"': { kind: 'fill', locator: password, value: 'secret' },
  'I fill in the password field with "wrong"': { kind: 'fill', locator: password, value: 'wrong' },
  'I click the Log in button': { kind: 'click', locator: logIn },
  'I press Enter in the password field': { kind: 'press', key: 'Enter', locator: password },
  'I fill in the new todo field with "Buy milk"': { kind: 'fill', locator: newTodo, value: 'Buy milk' },
  'I click the Add button': { kind: 'click', locator: add },
  'I should see "Welcome, alice"': sees('Welcome, alice'),
  'I should see "Buy milk"': sees('Buy milk'),
  'I should see "Invalid email or password"': sees('Invalid email or password'),
  'I should not see "Welcome"': { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Welcome' } },
  'the URL should contain "/todos"': { kind: 'assert', assertion: { form: 'url_contains', value: '/todos' } },
  'I fill in "Email" with "bob@example.com"': { kind: 'fill', locator: email, value: 'bob@example.com' },
  'I fill in "Password" with "secret"': { kind: 'fill', locator: password, value: 'secret' },
  'I click "Log in"': { kind: 'click', locator: logIn },
  'I should see "Welcome, bob"': sees('Welcome, bob'),
  'the "New todo" field should be visible': { kind: 'assert', assertion: { form: 'element_visible', locator: newTodo } },
  'I fill in "Email" with "dana@example.com"': { kind: 'fill', locator: email, value: 'dana@example.com' },
  'I submit "Feed the cat" as a new todo': { kind: 'fill', locator: newTodo, value: 'Feed the cat', submit: true },
  'I should see "Feed the cat"': sees('Feed the cat'),
  'I see a greeting for dana': { kind: 'assert', assertion: { form: 'semantic' } },
};
