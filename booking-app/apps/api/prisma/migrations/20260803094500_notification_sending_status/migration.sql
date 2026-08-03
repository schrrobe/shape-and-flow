-- Added after PENDING so the enum reads in lifecycle order. A worker claims a row by
-- moving it PENDING -> SENDING before calling the provider, which is what stops a
-- redelivered job from sending a second message.
ALTER TYPE "NotificationStatus" ADD VALUE 'SENDING' AFTER 'PENDING';
