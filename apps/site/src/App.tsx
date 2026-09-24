import Nav from './components/Nav.tsx'
import Hero from './components/Hero.tsx'
import Screenshots from './components/Screenshots.tsx'
import Surfaces from './components/Surfaces.tsx'
import Features from './components/Features.tsx'
import Memory from './components/Memory.tsx'
import Install from './components/Install.tsx'
import Footer from './components/Footer.tsx'

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Screenshots />
        <Surfaces />
        <Features />
        <Memory />
        <Install />
      </main>
      <Footer />
    </>
  )
}
