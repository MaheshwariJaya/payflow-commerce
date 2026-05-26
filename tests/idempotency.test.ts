import { idempotency } from '../src/middleware/idempotency.middleware';
import { LockUtil } from '../src/utils/lock.util';
import { PrismaClient } from '@prisma/client';

// Mock logger
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockFindUnique = (global as any).mockFindUnique;
const mockCreate = (global as any).mockCreate;
const mockUpdate = (global as any).mockUpdate;

// Mock LockUtil
jest.mock('../src/utils/lock.util', () => ({
  LockUtil: {
    acquireRedisLock: jest.fn(),
    releaseRedisLock: jest.fn(),
  },
}));

describe('Idempotency Middleware Tests', () => {
  let req: any;
  let res: any;
  let next: any;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      method: 'POST',
      headers: {
        'idempotency-key': 'test-idemp-key-123',
      },
      body: { amount: 5000 },
      ip: '127.0.0.1',
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      statusCode: 200,
    };

    next = jest.fn();
  });

  test('Should block and return 400 Bad Request if Idempotency-Key is missing on mutating requests', async () => {
    delete req.headers['idempotency-key'];

    const middleware = idempotency();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Bad Request',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('Should yield to next() if no previous key exists (initial request)', async () => {
    (LockUtil.acquireRedisLock as jest.Mock).mockResolvedValue('mock-token-abc');
    (LockUtil.releaseRedisLock as jest.Mock).mockResolvedValue(true);
    mockFindUnique.mockResolvedValue(null); // Key not found in DB
    mockCreate.mockResolvedValue({});

    const middleware = idempotency();
    await middleware(req, res, next);

    expect(LockUtil.acquireRedisLock).toHaveBeenCalled();
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { key: 'test-idemp-key-123' } });
    expect(mockCreate).toHaveBeenCalled();
    expect(LockUtil.releaseRedisLock).toHaveBeenCalledWith('idempotency:test-idemp-key-123', 'mock-token-abc');
    expect(next).toHaveBeenCalled();
  });

  test('Should return cached response on duplicate completed requests', async () => {
    (LockUtil.acquireRedisLock as jest.Mock).mockResolvedValue('mock-token-abc');
    (LockUtil.releaseRedisLock as jest.Mock).mockResolvedValue(true);

    // Hash matching current body { amount: 5000 }
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');

    mockFindUnique.mockResolvedValue({
      key: 'test-idemp-key-123',
      request_hash: hash,
      status: 'COMPLETED',
      response_status: 201,
      response_body: { success: true, id: 'tx_123' },
    });

    const middleware = idempotency();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, id: 'tx_123' });
    expect(next).not.toHaveBeenCalled();
  });

  test('Should return 400 Bad Request if key is reused with different request payload', async () => {
    (LockUtil.acquireRedisLock as jest.Mock).mockResolvedValue('mock-token-abc');
    (LockUtil.releaseRedisLock as jest.Mock).mockResolvedValue(true);

    mockFindUnique.mockResolvedValue({
      key: 'test-idemp-key-123',
      request_hash: 'different-payload-hash-xyz', // Mismatch!
      status: 'COMPLETED',
      response_status: 201,
      response_body: { success: true },
    });

    const middleware = idempotency();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('different request payload'),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('Should return 409 Conflict if duplicate request arrives while initial is still PENDING', async () => {
    (LockUtil.acquireRedisLock as jest.Mock).mockResolvedValue('mock-token-abc');
    (LockUtil.releaseRedisLock as jest.Mock).mockResolvedValue(true);

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');

    mockFindUnique.mockResolvedValue({
      key: 'test-idemp-key-123',
      request_hash: hash,
      status: 'PENDING',
    });

    const middleware = idempotency();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Conflict',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});
