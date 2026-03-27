import { useAuth } from '../context/AuthContext'
import { useFavorite } from '../hooks/useFavorites'
import { useNavigate } from 'react-router-dom'

/**
 * Star button to follow/unfollow a team or player.
 * Shows a filled star when favorited, outline when not.
 * If user is not logged in, clicking redirects to /login.
 *
 * Usage: <FavoriteButton type="team" targetId={teamId} />
 */
export default function FavoriteButton({ type, targetId, className = '' }) {
  const { user } = useAuth()
  const { isFavorited, toggle, loading } = useFavorite(type, targetId)
  const navigate = useNavigate()

  const handleClick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!user) {
      navigate('/login')
      return
    }
    toggle()
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      title={user ? (isFavorited ? 'Remove from favorites' : 'Add to favorites') : 'Log in to follow'}
      className={`inline-flex items-center justify-center transition-colors
                  ${loading ? 'opacity-50' : 'hover:scale-110'}
                  ${className}`}
    >
      {isFavorited ? (
        <svg className="w-5 h-5 text-yellow-400 fill-current" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ) : (
        <svg className="w-5 h-5 text-gray-300 hover:text-yellow-400" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.5}>
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      )}
    </button>
  )
}
