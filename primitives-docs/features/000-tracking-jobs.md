The workflow package has high volumn fine grained tracking. It emits a lot of events.

For Jobs, I'd also light tracking but id doesn't need to be fine grained.

These are the events:

## General
Failure and retries - these can be generic

## Continuouse
event when setup
event when executed - include the number of runs already

## Debounce
event for first event received
event when executed - include the count of events before execution and the reason for execution either max event or time based

## Task
event for each execution - include the number of runs already
event when schedule is set - info about the schedule
