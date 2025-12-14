Jobs tracking should not be as aggressive as workload tracking.

Jobs will be much higher volume, so we need to be smart about events that we send.

Here are the rules for what we want to track.

## Countinuous
* When start and we set the data send event (should send basic config info)
* When execute finishes and is successful
* When execute fails (should send error info)

## Debounces
* On first event send tracking event along with basic config info
* On sucess a after debounce execute send tracking event along with how many events were debounceed and how the debounce happened schedule or max number of events
* fail on execute along with how many events were debounceed and how the debounce happened schedule or max number of events

## WorkerPool TBD (this is high volume so I am trying to figure out rules here to not send many events but still capture workerPool lag and such)
