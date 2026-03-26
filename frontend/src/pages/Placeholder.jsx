export default function Placeholder({ title, description }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 rounded-full bg-nw-teal/10 flex items-center justify-center mb-6">
        <svg className="w-8 h-8 text-nw-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      </div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">{title}</h1>
      <p className="text-gray-400 text-sm max-w-md">
        {description || 'This page is under construction. Check back soon!'}
      </p>
    </div>
  )
}
