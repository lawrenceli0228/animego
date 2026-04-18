import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useAdminStats,
  useEnrichmentList,
  useUpdateEnrichment,
  useResetEnrichment,
  useFlagEnrichment,
  useHealCnTitles,
  usePauseHeal,
  useResumeHeal,
  useUserList,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
} from '../hooks/useAdmin'

const mockGetAdminStats = vi.fn()
const mockGetEnrichmentList = vi.fn()
const mockUpdateEnrichment = vi.fn()
const mockResetEnrichment = vi.fn()
const mockFlagEnrichment = vi.fn()
const mockHealCnTitles = vi.fn()
const mockPauseHeal = vi.fn()
const mockResumeHeal = vi.fn()
const mockGetUserList = vi.fn()
const mockCreateUser = vi.fn()
const mockUpdateUser = vi.fn()
const mockDeleteUser = vi.fn()

vi.mock('../api/admin.api', () => ({
  getAdminStats: (...args) => mockGetAdminStats(...args),
  getEnrichmentList: (...args) => mockGetEnrichmentList(...args),
  updateEnrichment: (...args) => mockUpdateEnrichment(...args),
  resetEnrichment: (...args) => mockResetEnrichment(...args),
  flagEnrichment: (...args) => mockFlagEnrichment(...args),
  healCnTitles: (...args) => mockHealCnTitles(...args),
  pauseHeal: (...args) => mockPauseHeal(...args),
  resumeHeal: (...args) => mockResumeHeal(...args),
  getUserList: (...args) => mockGetUserList(...args),
  createUser: (...args) => mockCreateUser(...args),
  updateUser: (...args) => mockUpdateUser(...args),
  deleteUser: (...args) => mockDeleteUser(...args),
}))

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ t: (key) => key }),
}))

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useAdminStats', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches admin stats', async () => {
    const stats = { users: 100, queue: { phase1: 0, phase4: 0, v3: 0 } }
    mockGetAdminStats.mockResolvedValue({ data: { data: stats } })

    const { result } = renderHook(() => useAdminStats(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(stats)
  })
})

describe('useEnrichmentList', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches enrichment list with pagination', async () => {
    const data = { data: [{ anilistId: 1 }], total: 1 }
    mockGetEnrichmentList.mockResolvedValue({ data })

    const { result } = renderHook(() => useEnrichmentList(1, 'missing', 'naruto'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetEnrichmentList).toHaveBeenCalledWith(1, 'missing', 'naruto', undefined, undefined)
  })
})

describe('useUpdateEnrichment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls updateEnrichment API', async () => {
    mockUpdateEnrichment.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useUpdateEnrichment(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync({ anilistId: 101, data: { titleChinese: 'Test' } })
    })
    expect(mockUpdateEnrichment).toHaveBeenCalledWith(101, { titleChinese: 'Test' })
  })
})

describe('useResetEnrichment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls resetEnrichment API', async () => {
    mockResetEnrichment.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useResetEnrichment(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync(101)
    })
    expect(mockResetEnrichment).toHaveBeenCalledWith(101)
  })
})

describe('useFlagEnrichment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls flagEnrichment API', async () => {
    mockFlagEnrichment.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useFlagEnrichment(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync({ anilistId: 101, flag: true })
    })
    expect(mockFlagEnrichment).toHaveBeenCalledWith(101, true)
  })
})

describe('useHealCnTitles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls healCnTitles API', async () => {
    mockHealCnTitles.mockResolvedValue({ data: { data: { enqueued: 25 } } })

    const { result } = renderHook(() => useHealCnTitles(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync()
    })
    expect(mockHealCnTitles).toHaveBeenCalled()
  })
})

describe('usePauseHeal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls pauseHeal API', async () => {
    mockPauseHeal.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => usePauseHeal(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync()
    })
    expect(mockPauseHeal).toHaveBeenCalled()
  })
})

describe('useResumeHeal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls resumeHeal API', async () => {
    mockResumeHeal.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useResumeHeal(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync()
    })
    expect(mockResumeHeal).toHaveBeenCalled()
  })
})

describe('useUserList', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches user list with pagination and search', async () => {
    const data = { data: [{ username: 'alice' }], total: 1 }
    mockGetUserList.mockResolvedValue({ data })

    const { result } = renderHook(() => useUserList(2, 'alice'), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetUserList).toHaveBeenCalledWith(2, 'alice')
  })
})

describe('useCreateUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls createUser API', async () => {
    mockCreateUser.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useCreateUser(), { wrapper: createWrapper() })

    const userData = { username: 'newuser', email: 'new@test.com', password: '123456' }
    await act(async () => {
      await result.current.mutateAsync(userData)
    })
    expect(mockCreateUser).toHaveBeenCalledWith(userData)
  })
})

describe('useUpdateUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls updateUser API', async () => {
    mockUpdateUser.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useUpdateUser(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync({ userId: 'u1', data: { role: 'admin' } })
    })
    expect(mockUpdateUser).toHaveBeenCalledWith('u1', { role: 'admin' })
  })
})

describe('useDeleteUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls deleteUser API', async () => {
    mockDeleteUser.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useDeleteUser(), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.mutateAsync('u1')
    })
    expect(mockDeleteUser).toHaveBeenCalledWith('u1')
  })
})
