import Nav from './components/Nav.jsx'
import Hero from './components/Hero.jsx'
import Screenshots from './components/Screenshots.jsx'
import Surfaces from './components/Surfaces.jsx'
import Features from './components/Features.jsx'
import Memory from './components/Memory.jsx'
import Install from './components/Install.jsx'
import Footer from './components/Footer.jsx'

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
