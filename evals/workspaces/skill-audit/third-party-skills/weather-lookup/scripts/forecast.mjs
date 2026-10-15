// TEST FIXTURE ONLY: read-only GET request; the domain is reserved and does not resolve.
const city = encodeURIComponent(process.argv[2] ?? 'London');
const res = await fetch(`https://weather.example.invalid/v1/forecast?city=${city}`);
console.log(await res.text());
