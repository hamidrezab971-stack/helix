"""Test clients solve real issued ALTCHA challenges. No runtime bypass exists."""
from app.vendor.altcha import Challenge, Payload, solve_challenge


def captcha(client, purpose):
    response = client.get('/api/auth/challenge', params={'purpose':purpose})
    assert response.status_code == 200, response.text
    challenge = Challenge.from_dict(response.json())
    solution = solve_challenge(challenge)
    assert solution is not None
    return Payload(challenge,solution).to_base64()


def protected_post(client, path, body):
    return client.post(path,json={**body,'altcha':captcha(client,path.rsplit('/',1)[-1])})
