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
