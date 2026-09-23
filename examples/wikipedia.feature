Feature: Wikipedia search

  Scenario: Looking up bagels
    Given I am on https://en.wikipedia.org
    When I search for "bagel"
    Then I see an article about bagels
    And the URL should contain "/wiki/Bagel"
