loopway is a basic api service that accepts webhooks from different defined sources and stores them in an event inbox for users in the CloudEvents specficition. There is then an api for listing the events in the inbox, locking and unlocking one, getting the next one with a lock, marking one as processed.

There are 3 core data types. User, the person using the app. Inbox, the destination that gets events. Event, the events themself.

Inboxes have different confirations. The first one will match what github needs.