export default function Mark({ className = 'h-7 w-7' }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}favicon.svg`} className={className} alt="" aria-hidden="true" />
}
