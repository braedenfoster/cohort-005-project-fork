# Cadence

An online course platform where learners buy courses and can ask for their money back.

## Language

### People

**Learner**:
A person who buys and takes courses.
_Avoid_: Student, user, customer

**Staff**:
The platform's own team, who approve or decline Refund Requests.
_Avoid_: Admin

**Team Admin**:
The person who buys Seats for a team and hands them out.
_Avoid_: Admin (on its own)

### Purchases

**Purchase**:
A learner buying one course, for one or more Seats.
_Avoid_: Order, transaction

**Seat**:
One learner's place in a course, bought as part of a Purchase.
_Avoid_: Coupon, licence

**Claimed**:
The state of a Seat that a learner has taken.
_Avoid_: Redeemed

**Refunded Purchase**:
A Purchase whose Refund Request staff approved. It no longer gives access to the course.
_Avoid_: Cancelled purchase, reversed purchase

### Refunds

**Refund Request**:
A learner's request to give back a whole Purchase in exchange for their money. It is Pending until staff approve or decline it.
_Avoid_: Cancellation, Reversal, Chargeback, refund (for the request itself)

**Pending**:
The state of a Refund Request that staff have not yet approved or declined.
_Avoid_: Open, requested

**Approved**:
The state of a Refund Request that staff accepted. It produces a Refund.
_Avoid_: Accepted, resolved

**Declined**:
The state of a Refund Request that staff turned down. It produces no Refund.
_Avoid_: Rejected, denied

**Refund**:
The money paid back to a learner when staff approve a Refund Request.
_Avoid_: Reversal, Chargeback, cancellation

**Refund Window**:
The period after a Purchase during which the learner can send a Refund Request.
_Avoid_: Cancel window, cancellation period

**Refund Amount**:
The full amount paid for the Purchase. It does not depend on the course's current price.
_Avoid_: Refundable amount, cancellation amount
