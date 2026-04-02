import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}))
vi.mock('../context/LanguageContext', () => ({
  useLang: vi.fn(),
}))
vi.mock('../hooks/useSocial', () => ({
  useFollow: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({
  default: vi.fn(),
}))

import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'
import { useFollow } from '../hooks/useSocial'
import toast from 'react-hot-toast'
import FollowButton from '../components/social/FollowButton'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

const t = (key) => key
const defaultUseFollow = { follow: vi.fn(), unfollow: vi.fn(), isPending: false }

function renderBtn(props) {
  return render(
    <MemoryRouter>
      <FollowButton {...props} />
    </MemoryRouter>
  )
}

describe('FollowButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLang.mockReturnValue({ t })
    useFollow.mockReturnValue(defaultUseFollow)
    useAuth.mockReturnValue({ user: { username: 'alice' } })
  })

  it('renders nothing when isSelf=true', () => {
    const { container } = renderBtn({ username: 'alice', isFollowing: false, isSelf: true })
    expect(container.firstChild).toBeNull()
  })

  it('navigates to /login when unauthenticated user clicks', () => {
    useAuth.mockReturnValue({ user: null })
    renderBtn({ username: 'bob', isFollowing: false, isSelf: false })
    fireEvent.click(screen.getByRole('button'))
    expect(mockNavigate).toHaveBeenCalledWith('/login')
  })

  it('shows follow button label when not following', () => {
    renderBtn({ username: 'bob', isFollowing: false, isSelf: false })
    expect(screen.getByRole('button')).toHaveTextContent('social.follow')
  })

  it('shows unfollow button label when following', () => {
    renderBtn({ username: 'bob', isFollowing: true, isSelf: false })
    expect(screen.getByRole('button')).toHaveTextContent('social.unfollow')
  })

  it('shows ... when isPending', () => {
    useFollow.mockReturnValue({ ...defaultUseFollow, isPending: true })
    renderBtn({ username: 'bob', isFollowing: false, isSelf: false })
    expect(screen.getByRole('button')).toHaveTextContent('...')
  })

  it('calls follow() and shows toast on follow click', () => {
    const follow = vi.fn()
    useFollow.mockReturnValue({ ...defaultUseFollow, follow })
    renderBtn({ username: 'bob', isFollowing: false, isSelf: false })
    fireEvent.click(screen.getByRole('button'))
    expect(follow).toHaveBeenCalled()
  })

  it('calls unfollow() on unfollow click', () => {
    const unfollow = vi.fn()
    useFollow.mockReturnValue({ ...defaultUseFollow, unfollow })
    renderBtn({ username: 'bob', isFollowing: true, isSelf: false })
    fireEvent.click(screen.getByRole('button'))
    expect(unfollow).toHaveBeenCalled()
  })

  it('has fixed minWidth of 88px', () => {
    renderBtn({ username: 'bob', isFollowing: false, isSelf: false })
    const btn = screen.getByRole('button')
    expect(btn.style.minWidth).toBe('88px')
  })
})
