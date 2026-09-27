# BOGO / FACTOR

https://i-komae.github.io/bogofactor/

The best integer factorization algorithm in the world. Give it a composite N and it finds a non-trivial factor in O(1).\*

Open `index.html` in a browser; there is no build step.

\* Best case.

## How it works

- N is screened for primality first (Miller–Rabin below 2⁶⁴, BPSW above). A prime is not searched.
- Candidates are the primes 2–17 and the integers coprime to 510510, up to ⌊√N⌋ (wheel-17).
- Web Workers draw candidates uniformly with replacement and test them in WebAssembly.
- A divisor d is reported only after d × q = N is checked with BigInt.

## Credits

- Music: [Cyber 08](https://maou.audio/bgm_cyber08/) by MaouDamashii (Koichi Morita), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- RSA challenge numbers: https://www.ontko.com/pub/rayo/primes/rsa_fact.html

- Code: [MIT License](LICENSE)
