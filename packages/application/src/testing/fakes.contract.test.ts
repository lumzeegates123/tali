import {
  describeClockContract,
  describeIdentityProviderContract,
  describeIdGeneratorContract,
  describeObjectStorageProviderContract,
  describeQueueProviderContract,
  describeUnitOfWorkContract,
} from "./contracts/index";
import {
  FakeIdentityProvider,
  FixedClock,
  InMemoryObjectStorage,
  InMemoryQueue,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
} from "./index";

const START = "2026-09-27T10:00:00.000Z";

describeClockContract("FixedClock", () => new FixedClock(START));

describeIdGeneratorContract("SequentialIdGenerator", () => new SequentialIdGenerator());

describeUnitOfWorkContract("InMemoryUnitOfWork", () => new InMemoryUnitOfWork());

describeQueueProviderContract("InMemoryQueue", async () => {
  const clock = new FixedClock(START);
  return {
    queue: new InMemoryQueue(clock),
    advanceSeconds: async (seconds) => {
      clock.advanceBySeconds(seconds);
    },
  };
});

describeObjectStorageProviderContract("InMemoryObjectStorage", async () => {
  const clock = new FixedClock(START);
  return { storage: new InMemoryObjectStorage(clock), now: () => clock.now() };
});

describeIdentityProviderContract("FakeIdentityProvider", async () => {
  const clock = new FixedClock(START);
  const provider = new FakeIdentityProvider(clock);
  return {
    provider,
    issueValidToken: async (subject) => provider.issueToken(subject),
    issueExpiredToken: async (subject) => {
      const token = provider.issueToken(subject, { ttlSeconds: 60 });
      clock.advanceBySeconds(61);
      return token;
    },
  };
});
