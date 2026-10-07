from fastapi import FastAPI

app = FastAPI(title="Smooth API")


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Smooth API is running"}
