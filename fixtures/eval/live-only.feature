Feature: Steps that need live Jev

  Background:
    Given I am on "/login"
    When I fill in "Email" with "dana@example.com"
    And I fill in "Password" with "secret"
    And I click "Log in"

  Scenario: typing that submits
    When I submit "Feed the cat" as a new todo
    Then I should see "Feed the cat"

  Scenario: a descriptive expectation
    Then I see a greeting for dana

  Scenario: a described expectation that can be pinned
    Then I see the todos page for dana

  Scenario: a value described rather than quoted
    When I fill in the new todo field with the greeting on the page
    And I click "Add"
    Then I should see "dana"

  Scenario: a target described rather than named
    When I click the link that signs me out
    Then I should see "Sign in"
