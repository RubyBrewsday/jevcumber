Feature: Wikipedia search

  Scenario: Looking up bagels
    Given I am on https://en.wikipedia.org
    When I search for "bagel"
    Then I should see "From Wikipedia, the free encyclopedia"
    And the URL should contain "/wiki/Bagel"
