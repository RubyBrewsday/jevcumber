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
  'I see the todos page for dana': { kind: 'assert', assertion: { form: 'semantic' } },
  'I fill in the new todo field with the greeting on the page': { kind: 'fill', locator: newTodo, value: 'Welcome, dana' },
  'I click "Add"': { kind: 'click', locator: add },
  'I should see "dana"': sees('dana'),
  'I click the link that signs me out': { kind: 'click', locator: { by: 'role', role: 'link', name: 'Sign out' } },
  'I should see "Sign in"': sees('Sign in'),
  'I hover over the Sign out link': { kind: 'hover', locator: { by: 'role', role: 'link', name: 'Sign out' } },
  'I clear the new todo field': { kind: 'clear', locator: newTodo },
  'I scroll to the Add button': { kind: 'scroll', locator: add },
  'I wait for "Welcome, dana" to appear': { kind: 'wait', text: 'Welcome, dana' },
  'I wait 1 second': { kind: 'wait', seconds: 1 },
  'I wait for the page to settle': { kind: 'wait' },
  'I upload "avatar.png" as the avatar': { kind: 'upload', locator: { by: 'label', value: 'Avatar' }, value: 'avatar.png' },
  'I check the Remind me box': { kind: 'check', locator: { by: 'role', role: 'checkbox', name: 'Remind me' } },
  'I choose "High" as the priority': { kind: 'select', locator: { by: 'role', role: 'combobox', name: 'Priority' }, value: 'High' },
  'I uncheck the Remind me box': { kind: 'uncheck', locator: { by: 'role', role: 'checkbox', name: 'Remind me' } },
};
