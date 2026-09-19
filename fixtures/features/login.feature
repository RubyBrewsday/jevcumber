Feature: Login

  Background:
    Given I am on "/login"

  Scenario: successful login
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "secret"
    And I click the Log in button
    Then I should see "Welcome, alice"
    And the URL should contain "/todos"

  Scenario: adding a todo after logging in
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "secret"
    And I press Enter in the password field
    And I fill in the new todo field with "Buy milk"
    And I click the Add button
    Then I should see "Buy milk"

  Scenario: wrong password
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "wrong"
    And I click the Log in button
    Then I should see "Invalid email or password"
    And I should not see "Welcome"
